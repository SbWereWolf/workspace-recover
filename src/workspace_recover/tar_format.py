"""Strict ustar/PAX reader; payloads remain on the private verified spool."""
import posixpath
import re


def archive_name(name):
    if not isinstance(name, str) or not name or "\0" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in name.split("/"):
        raise ValueError(f"unsafe archive path: {name}")
    return posixpath.normpath(name).rstrip("/") or "."


def padding(size): return (-size) % 512


def _text(block, start, length): return block[start:start + length].split(b"\0", 1)[0].decode("utf-8", errors="strict")


def _number(block, start, length):
    value = _text(block, start, length).strip()
    if not re.fullmatch(r"[0-7]*", value): raise ValueError("invalid tar numeric field")
    number = int(value or "0", 8)
    if number > 9007199254740991: raise ValueError("tar numeric field out of range")
    return number


def _read(stream, length, offset):
    stream.seek(offset)
    data = stream.read(length)
    if len(data) != length: raise ValueError("truncated tar data")
    return data


def _pax(data):
    allowed = {"path", "linkpath", "size", "mtime", "uid", "gid", "uname", "gname", "atime", "ctime", "comment", "charset"}
    result, offset = {}, 0
    while offset < len(data):
        space = data.find(b" ", offset)
        raw = data[offset:space] if space >= 0 else b""
        if not re.fullmatch(rb"[1-9][0-9]*", raw): raise ValueError("invalid PAX record length")
        length = int(raw)
        end = offset + length
        if end > len(data) or end <= space + 2 or data[end - 1] != 10: raise ValueError("invalid PAX record boundary")
        equal = data.find(b"=", space + 1, end - 1)
        if equal < space + 2: raise ValueError("invalid PAX keyword")
        key, value = data[space + 1:equal].decode("utf-8"), data[equal + 1:end - 1].decode("utf-8")
        if key not in allowed: raise ValueError(f"unsupported PAX keyword: {key}")
        if "\0" in value: raise ValueError("NUL in PAX record")
        result[key] = value
        offset = end
    return result


def tar_entries(stream):
    stream.seek(0, 2)
    total, offset, local, global_values, seen = stream.tell(), 0, None, {}, set()
    while True:
        if offset + 512 > total: raise ValueError("missing or truncated tar end marker")
        block = _read(stream, 512, offset)
        offset += 512
        if not any(block):
            if local is not None: raise ValueError("orphan PAX header")
            if offset + 512 > total: raise ValueError("missing second tar end marker")
            if total % 512: raise ValueError("invalid tar trailing size")
            while offset < total:
                data = _read(stream, min(1024 * 1024, total - offset), offset)
                if any(data): raise ValueError("nonzero data after tar end marker")
                offset += len(data)
            return
        check = bytearray(block)
        check[148:156] = b" " * 8
        if _number(block, 148, 8) != sum(check): raise ValueError("invalid tar header checksum")
        if _text(block, 257, 6) != "ustar": raise ValueError("unsupported tar header format")
        kind = _text(block, 156, 1) or "0"
        raw_size, mode = _number(block, 124, 12), _number(block, 100, 8)
        if mode > 0o7777: raise ValueError("invalid tar mode")
        if kind in ("x", "g"):
            if raw_size > 1024 * 1024: raise ValueError("PAX metadata exceeds 1 MiB limit")
            if offset + raw_size + padding(raw_size) > total: raise ValueError("truncated PAX data")
            attrs = _pax(_read(stream, raw_size, offset))
            if kind == "x": local = {**(local or {}), **attrs}
            else:
                for key, value in attrs.items():
                    if value == "": global_values.pop(key, None)
                    else: global_values[key] = value
            offset += raw_size + padding(raw_size)
            continue
        if kind not in ("0", "2", "5"): raise ValueError(f"unsupported tar entry type {kind}")
        attrs = {**global_values, **(local or {})}
        local = None
        if attrs.get("path"): full_name = attrs["path"]
        else:
            prefix = _text(block, 345, 155)
            full_name = (prefix + "/" if prefix else "") + _text(block, 0, 100)
        name = archive_name(full_name)
        link = attrs.get("linkpath") or _text(block, 157, 100)
        if "size" in attrs and not re.fullmatch(r"[0-9]+", attrs["size"]): raise ValueError("invalid PAX size")
        size = int(attrs["size"]) if "size" in attrs else raw_size
        if size > 9007199254740991 or offset + size + padding(size) > 9007199254740991: raise ValueError("invalid tar entry size")
        if kind != "0" and size: raise ValueError("non-file tar entry has payload")
        if offset + size + padding(size) > total: raise ValueError(f"truncated file data: {full_name}")
        if name == "." and kind != "5": raise ValueError("archive root must be a directory")
        if name in seen: raise ValueError(f"duplicate archive path: {name}")
        seen.add(name)
        if kind == "2":
            endpoint = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
            if not link or "\0" in link or link.startswith("/") or re.match(r"^[A-Za-z]:", link) or endpoint == ".." or endpoint.startswith("../"):
                raise ValueError(f"symlink escapes target or is unsafe: {name} -> {link}")
        yield {"name": name, "fullName": full_name, "type": kind, "size": size, "mode": mode, "linkname": link, "offset": offset}
        offset += size + padding(size)
