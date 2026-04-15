"""
替代 Python 3.13+ 已移除的 cgi.FieldStorage：仅解析 multipart/form-data，
满足 sheet_mapping_server 上传与表单字段读取。
"""

from __future__ import annotations

import io
import re
from typing import Any


def _extract_boundary(content_type: str) -> str | None:
    ct = content_type or ""
    for part in ct.split(";"):
        part = part.strip()
        if part.lower().startswith("boundary="):
            b = part[9:].strip()
            if len(b) >= 2 and b[0] == b[-1] == '"':
                b = b[1:-1]
            return b or None
    return None


def _parse_content_disposition(header_block: str) -> tuple[str | None, str | None]:
    """从单个 part 的头块中解析 name 与 filename。"""
    name: str | None = None
    filename: str | None = None
    for line in header_block.replace("\n", "\r").split("\r"):
        if line.lower().startswith("content-disposition:"):
            m = re.search(r'\bname="([^"]*)"', line, re.I)
            if m:
                name = m.group(1)
            else:
                m2 = re.search(r"\bname=([^;\s]+)", line, re.I)
                if m2:
                    name = m2.group(1).strip()
            mf = re.search(r'\bfilename="([^"]*)"', line, re.I)
            if mf:
                filename = mf.group(1)
            else:
                mf2 = re.search(r"\bfilename=([^;\s]+)", line, re.I)
                if mf2:
                    filename = mf2.group(1).strip().strip('"')
            break
    return name, filename


class MultipartPart:
    def __init__(self, name: str, filename: str | None, body: bytes) -> None:
        self.name = name
        self.filename = filename or None
        self._body = body
        self.file = io.BytesIO(body)
        if self.filename:
            self.value: Any = body
        else:
            self.value = body.decode("utf-8", errors="replace")


class MultipartForm:
    """兼容 cgi.FieldStorage 的 list / in / [] 访问。"""

    def __init__(self, parts: list[MultipartPart]) -> None:
        self.list: list[MultipartPart] = parts
        self._by_name: dict[str, list[MultipartPart]] = {}
        for p in parts:
            self._by_name.setdefault(p.name, []).append(p)

    def __contains__(self, name: str) -> bool:
        return name in self._by_name

    def __getitem__(self, name: str) -> MultipartPart | list[MultipartPart]:
        items = self._by_name.get(name, [])
        if not items:
            raise KeyError(name)
        if len(items) == 1:
            return items[0]
        return items


def parse_multipart_form_data(content_type: str, body: bytes) -> MultipartForm:
    if "multipart/form-data" not in (content_type or "").lower():
        raise ValueError("Content-Type 不是 multipart/form-data")
    boundary = _extract_boundary(content_type)
    if not boundary:
        raise ValueError("缺少 multipart boundary")
    b_b = boundary.encode("ascii", errors="surrogateescape")

    d0 = b"--" + b_b + b"\r\n"
    d1 = b"\r\n--" + b_b + b"\r\n"

    raw = body
    if raw.startswith(d0):
        inner = raw[len(d0) :]
    elif raw.startswith(b"--" + b_b + b"\n"):
        inner = raw[len(b"--" + b_b) + 1 :]
    elif raw.startswith(d1):
        inner = raw[len(d1) :]
    else:
        inner = raw

    segments = inner.split(b"\r\n--" + b_b + b"\r\n")
    parts: list[MultipartPart] = []

    for seg in segments:
        if not seg:
            continue
        if seg == b"--" or seg.startswith(b"--\r\n"):
            break
        if seg.endswith(b"--"):
            seg = seg[:-2].rstrip(b"\r\n")
        hdr_sep = seg.find(b"\r\n\r\n")
        if hdr_sep < 0:
            hdr_sep = seg.find(b"\n\n")
            if hdr_sep < 0:
                continue
            header_bytes = seg[:hdr_sep]
            payload = seg[hdr_sep + 2 :]
        else:
            header_bytes = seg[:hdr_sep]
            payload = seg[hdr_sep + 4 :]

        payload = payload.rstrip(b"\r\n")
        headers = header_bytes.decode("utf-8", errors="replace")
        nm, fn = _parse_content_disposition(headers)
        if not nm:
            continue
        parts.append(MultipartPart(nm, fn, payload))

    return MultipartForm(parts)
