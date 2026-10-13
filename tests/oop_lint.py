#!/usr/bin/env python3
"""Static OOP + extension-format enforcement for pi-consult.

House rule (shared memory): owned program logic is structured as classes
with single-responsibility methods; state is mutated only by its owning
object or explicitly through an input parameter - never through module
globals or another function's side effects.

Checks over src/ (recursively):
  1. No top-level mutable bindings (`let`/`var`, or `const` containers
     such as Map/Set/object/array at module scope). Classes may own
     mutable instance and static fields.
  2. No top-level function or arrow helpers, except the entry module's
     `export default function`.
  3. src/index.ts declares a default export; src/ contains only .ts files.
"""

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "src")
FAILURES: list[str] = []

TS_TOP_LEVEL_BAD = [
    (r"^\s*(export\s+)?let\s+", "top-level let binding"),
    (r"^\s*(export\s+)?var\s+", "top-level var binding"),
]
TS_CONST_CONTAINER = re.compile(
    r"^\s*(export\s+)?const\s+\w+(\s*:[^=]+)?\s*=\s*(new\s+(Map|Set)\b|\{|\[)"
)
TS_TOP_LEVEL_FUNCTION = re.compile(r"^\s*(export\s+)?(async\s+)?function\s+")
TS_TOP_LEVEL_ARROW = re.compile(r"^\s*(export\s+)?const\s+\w+(\s*:[^=]+)?\s*=\s*(async\s*)?\(")


def fail(path: str, message: str) -> None:
    FAILURES.append(f"{path}: {message}")


def strip_line_noise(line: str, in_block: bool) -> tuple[str, bool]:
    """Remove comments and string/template literals so brace counting and
    declaration matching only see real code."""
    out: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        if in_block:
            end = line.find("*/", i)
            if end == -1:
                return "".join(out), True
            i = end + 2
            in_block = False
            continue
        two = line[i:i + 2]
        if two == "//":
            break
        if two == "/*":
            in_block = True
            i += 2
            continue
        ch = line[i]
        if ch in ('"', "'", "`"):
            i += 1
            while i < n:
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == ch:
                    i += 1
                    break
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out), in_block


def check_typescript(path: str) -> None:
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()
    depth = 0
    in_block = False
    for lineno, raw in enumerate(lines, 1):
        cleaned, in_block = strip_line_noise(raw.rstrip("\n"), in_block)
        stripped = cleaned.strip()
        if depth == 0 and stripped:
            for pattern, label in TS_TOP_LEVEL_BAD:
                if re.match(pattern, stripped):
                    fail(path, f"line {lineno}: {label}: {stripped[:60]}")
            if TS_CONST_CONTAINER.match(stripped):
                fail(path, f"line {lineno}: top-level mutable const container: {stripped[:60]}")
            if TS_TOP_LEVEL_FUNCTION.match(stripped) and not stripped.startswith(
                "export default function"
            ):
                fail(path, f"line {lineno}: top-level function helper: {stripped[:60]}")
            if TS_TOP_LEVEL_ARROW.match(stripped):
                fail(path, f"line {lineno}: top-level arrow helper: {stripped[:60]}")
        depth += cleaned.count("{") - cleaned.count("}")
        if depth < 0:
            depth = 0


def main() -> int:
    if not os.path.isdir(SRC):
        print("oop lint: missing src/", file=sys.stderr)
        return 1
    for root, _dirs, files in os.walk(SRC):
        for name in sorted(files):
            path = os.path.join(root, name)
            if not name.endswith(".ts"):
                fail(path, "src/ contains a non-TypeScript file")
                continue
            if name.endswith(".test.ts"):
                fail(path, "tests must live under tests/, not src/")
                continue
            check_typescript(path)
    entry = os.path.join(SRC, "index.ts")
    if os.path.isfile(entry):
        with open(entry, "r", encoding="utf-8") as handle:
            if "export default" not in handle.read():
                fail(entry, "entry module must declare a default export")
    else:
        fail(entry, "missing src/index.ts")

    if FAILURES:
        for failure in FAILURES:
            print(f"oop lint: {failure}", file=sys.stderr)
        return 1
    print("oop lint: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
