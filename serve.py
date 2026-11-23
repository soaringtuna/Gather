#!/usr/bin/env python3
"""Serve the class record and read Ontario curriculum pages on demand.

The ministry curriculum site does not allow a browser on this origin to read
its catalogue directly, so Load Expectations calls /api/curriculum here.
Courses that are not in a PDF are read from the curriculum website. A focus
course such as TGJ1O uses the expectations of the course it is based on.
"""

import html
import io
import json
import os
import re
import threading
import warnings
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

warnings.filterwarnings("ignore", message=".*fontTools.*")

ROOT = __file__.rsplit("/", 1)[0]
API = "https://ws.api.dcp.edu.gov.on.ca/content/api"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36"
CODE_RE = re.compile(r"^[A-Z]{3}[1-4][A-Z0-9]$")
EXP_SPLIT = re.compile(r"(?<![A-Za-z0-9.])([A-Z]\d{1,2}(?:\.\d{1,2})?)\.?\s+(?=[a-z])")
PORT = int(os.environ.get("PORT", "8765"))

_lock = threading.Lock()
_documents = {}
_pdf_bytes = {}
_focus_bases = None


def api_get(path, params):
    url = f"{API}/{path}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": UA})
    with urlopen(request, timeout=45) as response:
        return json.load(response)


def plain_html(value):
    text = re.sub(r"<[^>]+>", " ", value or "")
    text = html.unescape(text).replace("\xa0", " ").replace("\u200b", "").replace("\u00ad", "")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    return text.strip()


def expectation_id(course_code, exp_code):
    slug = re.sub(r"[^a-z0-9]+", "-", f"{course_code}-{exp_code}".lower()).strip("-")
    return f"cur-{slug}"


def record(course_code, exp_code, label, detail, strand, group, specific):
    text = re.sub(r"\s+", " ", label).strip(" ;")
    detail_text = re.sub(r"\s+", " ", detail or text).strip(" ;")
    if len(text) > 700:
        text = text[:697].rstrip() + "..."
    return {
        "id": expectation_id(course_code, exp_code),
        "label": text,
        "detail": detail_text or text,
        "strand": strand or "",
        "group": group or strand or "",
        "specific": bool(specific),
    }


def course_items(code):
    data = api_get("items", {
        "system.type": "l2___course",
        "elements.code[eq]": code,
        "depth": "1",
        "limit": "10",
        "language": "en-CA",
    })
    return data.get("items") or [], data.get("modular_content") or {}


def strand_codenames(item, modular):
    found = []
    for codename in (item.get("elements") or {}).get("sections", {}).get("value") or []:
        mod = modular.get(codename) or {}
        if (mod.get("system") or {}).get("type") != "ui___content_collection":
            continue
        name = ((mod.get("system") or {}).get("name") or "").lower()
        kids = (mod.get("elements") or {}).get("sections", {}).get("value") or []
        if kids and "strand" in name:
            found.append(codename)
    return found


def choose_course(items, modular):
    ranked = []
    for item in items:
        strands = strand_codenames(item, modular)
        year = (item.get("elements") or {}).get("year_issued", {}).get("value") or ""
        ranked.append((1 if strands else 0, year, len(strands), item, strands))
    ranked.sort(key=lambda row: (row[0], row[1], row[2]), reverse=True)
    return ranked[0] if ranked else None


def fetch_codenames(names):
    found = {}
    pending = [name for name in names if name]
    while pending:
        batch = pending[:40]
        pending = pending[40:]
        data = api_get("items", {
            "system.codename[in]": ",".join(batch),
            "depth": "0",
            "limit": str(len(batch)),
            "language": "en-CA",
        })
        for item in data.get("items") or []:
            found[item["system"]["codename"]] = item
        returned = {item["system"]["codename"] for item in data.get("items") or []}
        for name in batch:
            if name not in returned and name not in found:
                try:
                    one = api_get(f"items/{name}", {"depth": "0", "language": "en-CA"})
                    item = one.get("item") or (one.get("items") or [None])[0]
                    if item:
                        found[item["system"]["codename"]] = item
                except Exception:
                    continue
    return found


def fill_digital_items(code, strand_names):
    items = []
    for strand_name in strand_names:
        data = api_get(f"items/{strand_name}", {"depth": "3", "language": "en-CA"})
        root = data.get("item") or (data.get("items") or [None])[0]
        modular = dict(data.get("modular_content") or {})
        if root:
            modular[root["system"]["codename"]] = root
        missing = []
        for entry in modular.values():
            if entry["system"]["type"] != "l4___overall_expectation":
                continue
            for spec_name in (entry.get("elements") or {}).get("specific_expectations", {}).get("value") or []:
                if spec_name not in modular:
                    missing.append(spec_name)
        if missing:
            modular.update(fetch_codenames(missing))
        for name in (root.get("elements") or {}).get("sections", {}).get("value") or []:
            strand = modular.get(name)
            if not strand or strand["system"]["type"] != "l3___strand":
                continue
            strand_title = plain_html((strand.get("elements") or {}).get("title", {}).get("value")) or ""
            for overall_name in (strand.get("elements") or {}).get("overall_expectations", {}).get("value") or []:
                overall = modular.get(overall_name)
                if not overall or overall["system"]["type"] != "l4___overall_expectation":
                    continue
                elements = overall.get("elements") or {}
                exp_code = plain_html(elements.get("title_index", {}).get("value"))
                title = plain_html(elements.get("title", {}).get("value"))
                sentence = plain_html(elements.get("content", {}).get("value"))
                if not exp_code:
                    continue
                family = f"{exp_code} {title}".strip()
                items.append(record(code, exp_code, family, sentence or title or family, strand_title, family, False))
                for spec_name in elements.get("specific_expectations", {}).get("value") or []:
                    spec = modular.get(spec_name)
                    if not spec or spec["system"]["type"] != "l5___specific_expectation":
                        continue
                    spec_elements = spec.get("elements") or {}
                    spec_code = plain_html(spec_elements.get("title_index", {}).get("value")) or exp_code
                    spec_text = plain_html(spec_elements.get("content", {}).get("value"))
                    spec_title = plain_html(spec_elements.get("title", {}).get("value"))
                    body = spec_text or spec_title
                    if not body:
                        continue
                    items.append(record(code, spec_code, f"{spec_code} {body}", body, strand_title, family, True))
    return items


def citation_for_course(item, modular):
    elements = item.get("elements") or {}
    year = plain_html(elements.get("year_issued", {}).get("value"))
    name = plain_html(elements.get("name", {}).get("value"))
    discipline = ""
    for entry in elements.get("site___curriculum_disciplines", {}).get("value") or []:
        if isinstance(entry, dict) and entry.get("name"):
            discipline = entry["name"]
            break
    document = ""
    for codename in elements.get("part_of", {}).get("value") or []:
        parent = modular.get(codename) or {}
        parent_elements = parent.get("elements") or {}
        document = plain_html(parent_elements.get("title", {}).get("value") or parent_elements.get("banner_title", {}).get("value"))
        if document:
            break
    parts = ["The Ontario Curriculum"]
    if document:
        parts.append(document)
    elif discipline:
        parts.append(discipline)
    if name:
        parts.append(name)
    if year:
        parts.append(year)
    return ", ".join(parts)


def asset_url(resource):
    elements = resource.get("elements") or {}
    upload = elements.get("resource_upload", {}).get("value") or []
    if upload and isinstance(upload[0], dict) and upload[0].get("url"):
        return upload[0]["url"], plain_html(elements.get("title", {}).get("value")) or upload[0].get("name") or "Curriculum document"
    external = plain_html(elements.get("external_url", {}).get("value"))
    if external.startswith("http"):
        return external, plain_html(elements.get("title", {}).get("value")) or "Curriculum document"
    return "", ""


def pdf_candidates(item, modular):
    elements = item.get("elements") or {}
    names = list(elements.get("course_pdfs", {}).get("value") or [])
    seen = set(names)
    parents = list(elements.get("part_of", {}).get("value") or [])
    index = 0
    while index < len(parents) and index < 8:
        codename = parents[index]
        index += 1
        parent = modular.get(codename)
        if not parent:
            try:
                data = api_get(f"items/{codename}", {"depth": "1", "language": "en-CA"})
            except Exception:
                continue
            parent = data.get("item") or (data.get("items") or [None])[0]
            modular = {**modular, **(data.get("modular_content") or {})}
            if parent:
                modular[parent["system"]["codename"]] = parent
        if not parent:
            continue
        parent_elements = parent.get("elements") or {}
        for key in ("curriculum_pdfs", "l1___curriculum", "part_of"):
            for child in parent_elements.get(key, {}).get("value") or []:
                if isinstance(child, str) and child not in seen:
                    seen.add(child)
                    parents.append(child)
        if parent["system"]["type"] == "resources":
            names.append(codename)
    grade_digit = {"1": "9", "2": "10", "3": "11", "4": "12"}.get(item["elements"]["code"]["value"][3], "")
    ranked = []
    for name in names:
        resource = modular.get(name)
        if not resource or resource["system"]["type"] != "resources":
            try:
                data = api_get(f"items/{name}", {"depth": "0", "language": "en-CA"})
                resource = data.get("item") or (data.get("items") or [None])[0]
            except Exception:
                resource = None
        if not resource:
            continue
        url, title = asset_url(resource)
        if not url:
            continue
        label = f"{title} {url}".lower()
        if any(skip in label for skip in ("addenda", "addendum", "key change", "sample course", "webinar")):
            rank = 2
        elif grade_digit and re.search(rf"\b{grade_digit}\b", title):
            rank = 0
        else:
            rank = 1
        ranked.append((rank, title, url))
    ranked.sort(key=lambda row: row[0])
    unique = []
    used = set()
    for _, title, url in ranked:
        if url in used:
            continue
        used.add(url)
        unique.append((title, url))
    return unique


def download_pdf(url):
    with _lock:
        cached = _pdf_bytes.get(url)
    if cached:
        return cached
    request = Request(url, headers={"User-Agent": UA})
    with urlopen(request, timeout=60) as response:
        blob = response.read(28_000_000)
    with _lock:
        _pdf_bytes[url] = blob
    return blob


def pdf_pages(blob):
    from pypdf import PdfReader

    warnings.filterwarnings("ignore")
    reader = PdfReader(io.BytesIO(blob))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        text = text.replace("\u00ad", "")
        text = re.sub(r"-\s*\n\s*(?=[a-z])", "", text)
        pages.append(text)
    return pages


def looks_like_contents(text):
    return text.count(". .") > 6 or text.count("....") > 3


def course_codes_on_page(text):
    return set(re.findall(r"\b([A-Z]{3}[1-4][A-Z0-9])\b", text))


def course_pages(pages, code):
    start = None
    for index, text in enumerate(pages):
        if code not in course_codes_on_page(text):
            continue
        if looks_like_contents(text) or len(course_codes_on_page(text)) >= 3:
            continue
        window = "\n".join(pages[index:index + 2])
        if re.search(r"OVERALL EXPECTATIONS|Overall Expectations", window):
            start = index
            break
    if start is None:
        return ""
    end = len(pages)
    heading = re.compile(r"(?:Preparation|Open|Academic|Applied)\s+([A-Z]{3}[1-4][A-Z0-9])\b")
    for index in range(start + 1, len(pages)):
        text = pages[index]
        if looks_like_contents(text):
            continue
        codes = {found for found in course_codes_on_page(text) if found != code}
        titled = {found for found in heading.findall(text) if found != code}
        paren = {found for found in re.findall(r"\(([A-Z]{3}[1-4][A-Z0-9])\)", text) if found != code}
        if titled or paren or (len(codes) == 1 and re.search(r"Grade\s+\d+", text) and not re.search(rf"\b{code}\b", text)):
            end = index
            break
    text = "\n".join(pages[start:end])
    title = re.search(rf"\({code}\)|(?:Preparation|Open|Academic|Applied)\s+{code}\b", text)
    if title:
        text = text[title.end():]
    return text


def clean_sentence(text):
    text = re.split(r"\bSample problem:", text, maxsplit=1)[0]
    text = re.split(r"OVERALL EXPECTATIONS|SPECIFIC EXPECTATIONS|Overall Expectations|Specific Expectations|THE ONTARIO CURRICULUM|By the end of this course", text, maxsplit=1)[0]
    text = re.sub(r"\s+", " ", text).strip(" ;,.")
    return text


def coded_expectations(course_code, text):
    parts = EXP_SPLIT.split(text)
    found = {}
    index = 1
    while index + 1 < len(parts):
        exp_code = parts[index]
        sentence = clean_sentence(parts[index + 1])
        index += 2
        if len(sentence) < 25:
            continue
        previous = found.get(exp_code)
        if previous and len(previous) >= len(sentence):
            continue
        found[exp_code] = sentence
    def sort_key(exp_code):
        match = re.match(r"([A-Z])(\d+)(?:\.(\d+))?", exp_code)
        if not match:
            return (exp_code, 0, 0)
        return (match.group(1), int(match.group(2)), int(match.group(3) or 0))
    items = []
    for exp_code in sorted(found, key=sort_key):
        sentence = found[exp_code]
        specific = "." in exp_code
        letter = exp_code[0]
        family = exp_code.split(".")[0]
        items.append(record(course_code, exp_code, f"{exp_code} {sentence}", sentence, f"Strand {letter}", family, specific))
    return items


def bullet_expectations(course_code, text):
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    items = []
    strand = ""
    pending_heading = ""
    mode = ""
    buffer = None

    def flush():
        nonlocal buffer
        if not buffer:
            return
        kind, body = buffer
        buffer = None
        sentence = clean_sentence(body)
        if len(sentence) < 25:
            return
        specific = kind == "specific"
        exp_code = f"{'S' if specific else 'O'}{len(items) + 1}"
        group = strand or "Expectations"
        items.append(record(course_code, exp_code, sentence, sentence, group, group, specific))

    for line in lines:
        if re.fullmatch(r"overall expectations", line, re.I):
            flush()
            if pending_heading:
                strand = pending_heading
                pending_heading = ""
            mode = "overall"
            continue
        if re.fullmatch(r"specific expectations", line, re.I):
            flush()
            mode = "specific"
            continue
        bullet = re.match(r"^[•●]\s+(.+)$", line)
        dash = re.match(r"^[–—]\s+(.+)$", line) or re.match(r"^-\s+(.+)$", line)
        if bullet:
            flush()
            buffer = ("overall", bullet.group(1))
            mode = "overall"
            continue
        if dash and mode == "specific":
            flush()
            buffer = ("specific", dash.group(1))
            continue
        if buffer:
            buffer = (buffer[0], f"{buffer[1]} {line}")
            continue
        if 8 < len(line) < 90 and not re.search(r"grade\s+\d+|ontario curriculum|prerequisite|preparation|academic \(|applied \(", line, re.I):
            pending_heading = line
    flush()
    return items


def expectations_from_pdf(course_code, title, blob):
    pages = pdf_pages(blob)
    text = course_pages(pages, course_code)
    if not text.strip():
        return []
    coded = coded_expectations(course_code, text)
    if len([item for item in coded if not item["specific"]]) >= 3:
        return coded
    bullets = bullet_expectations(course_code, text)
    if len(bullets) > len(coded):
        return bullets
    return coded


def html_lines(value):
    text = re.sub(r"<[^>]+>", "\n", value or "")
    text = html.unescape(text).replace("\xa0", " ").replace("\u200b", "").replace("\u00ad", "")
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return lines


def collect_html(value, found):
    if isinstance(value, str):
        lowered = value.lower()
        if "basis of the expectations" in lowered or "focus courses" in lowered:
            found.append(value)
    elif isinstance(value, dict):
        for child in value.values():
            collect_html(child, found)
    elif isinstance(value, list):
        for child in value:
            collect_html(child, found)


def focus_course_bases():
    """Read the curriculum website for courses that use another course's expectations."""
    global _focus_bases
    with _lock:
        cached = _focus_bases
    if cached is not None:
        return cached
    mapping = {}
    try:
        data = api_get("items", {
            "elements.url_slug[eq]": "g9-10-program",
            "depth": "5",
            "limit": "5",
            "language": "en-CA",
        })
    except Exception:
        data = {}
    chunks = []
    collect_html(data, chunks)
    lines = []
    for chunk in chunks:
        lines.extend(html_lines(chunk))
    basis = " ".join(line for line in lines if "basis of the expectations" in line.lower())
    grade_bases = {}
    for grade, base in re.findall(r"Grade\s+(9|10|11|12)\s+\(([A-Z]{3}[1-4][A-Z0-9])\)", basis):
        grade_bases[grade] = base
    grade = ""
    for line in lines:
        heading = re.search(r"related to Grade\s+(9|10|11|12)\b", line, re.I)
        if heading:
            grade = heading.group(1)
            continue
        match = re.match(r"^([A-Z]{3}[1-4][A-Z0-9])\s+[–—-]\s+\S", line)
        if match and grade in grade_bases and grade_bases[grade] != match.group(1):
            mapping[match.group(1)] = grade_bases[grade]
    with _lock:
        _focus_bases = mapping
    return mapping


def retag_expectations(course_code, items):
    retagged = []
    for item in items:
        exp_code = item["label"].split(" ", 1)[0]
        copy = dict(item)
        copy["id"] = expectation_id(course_code, exp_code)
        retagged.append(copy)
    return retagged


def document_for_code(code, depth=0):
    with _lock:
        cached = _documents.get(code)
    if cached:
        return cached
    items, modular = course_items(code)
    item = None
    strands = []
    citation = ""
    expectations = []
    if items:
        chosen = choose_course(items, modular)
        _, _, _, item, strands = chosen
        citation = citation_for_course(item, modular) if item else ""
        expectations = fill_digital_items(code, strands) if strands else []
        if not expectations and item:
            for title, url in pdf_candidates(item, modular):
                try:
                    blob = download_pdf(url)
                    expectations = expectations_from_pdf(code, title, blob)
                except Exception:
                    expectations = []
                if expectations:
                    citation = title or citation
                    break
    if not expectations and depth == 0:
        base = focus_course_bases().get(code)
        if base and base != code:
            borrowed = document_for_code(base, depth=1)
            if borrowed.get("items"):
                expectations = retag_expectations(code, borrowed["items"])
                citation = f"{borrowed['citation']}. {code} is a focus course based on {base}."
    payload = {
        "citation": citation,
        "hasSpecific": any(entry["specific"] for entry in expectations),
        "items": expectations,
        "error": "" if expectations else f"No expectations were found in the curriculum document for {code}.",
    }
    if expectations:
        with _lock:
            _documents[code] = payload
    return payload


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/curriculum":
            return super().do_GET()
        code = (parse_qs(parsed.query).get("code") or [""])[0].strip().upper()
        if not CODE_RE.match(code):
            body = json.dumps({"citation": "", "hasSpecific": False, "items": [], "error": "Choose an Ontario course code first."}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            payload = document_for_code(code)
            status = 200
        except Exception:
            payload = {"citation": "", "hasSpecific": False, "items": [], "error": "The curriculum document could not be reached."}
            status = 502
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if str(args[0]).startswith("GET /api/curriculum"):
            super().log_message(fmt, *args)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Class record at http://127.0.0.1:{PORT}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
