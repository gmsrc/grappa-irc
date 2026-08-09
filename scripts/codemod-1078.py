#!/usr/bin/env python3
"""#1078 codemod: point the wrapped e2e specs at their own subject.

`getSeededVjt()` -> `specUser()`, `NETWORK_NICK` -> `specNick()`, with the
imports moved from ../fixtures/seedData to ../fixtures/test (where the
fixture that provides them lives).

Both replacements are safe as pure textual renames ONLY because neither
identifier is captured into a module-scope initializer, which would
evaluate it at import time instead of at test time. That was measured
before writing this (0 captures for getSeededVjt, 4 for NETWORK_NICK);
the four are listed in EAGER_CAPTURES and are refused here so they get a
hand fix instead of a silently-broken one.

Throwaway: delete once the migration has landed.
"""

import pathlib
import re
import sys

TESTS = pathlib.Path("cicchetto/e2e/tests")
WRAPPED_IMPORT = '../fixtures/test'
SEEDDATA_IMPORT = '../fixtures/seedData'

# Module-scope initializers that read the value at import time. A rename
# would compile and then throw "no subject for the current test" at file
# load. Hand-fixed separately.
EAGER_CAPTURES = re.compile(r"^(const|let|var)\s+[^=\n]*=\s*(?![^\n]*=>)[^\n]*\bNETWORK_NICK\b", re.M)


def parse_import(src: str, module: str):
    """Return (whole_statement, [names]) for `import { ... } from "<module>"`."""
    m = re.search(
        r'import\s*\{([^}]*)\}\s*from\s*"' + re.escape(module) + r'";\n',
        src,
    )
    if not m:
        return None, None
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    return m.group(0), names


def render_import(names, module):
    body = ", ".join(sorted(names, key=str.lower))
    line = f'import {{ {body} }} from "{module}";\n'
    if len(line) <= 101:  # biome's line width for this repo
        return line
    inner = "".join(f"  {n},\n" for n in sorted(names, key=str.lower))
    return f'import {{\n{inner}}} from "{module}";\n'


def migrate(path: pathlib.Path):
    src = path.read_text()

    test_stmt, test_names = parse_import(src, WRAPPED_IMPORT)
    if test_stmt is None:
        return None, "not-wrapped"

    seed_stmt, seed_names = parse_import(src, SEEDDATA_IMPORT)

    uses_user = "getSeededVjt(" in src
    uses_nick = re.search(r"\bNETWORK_NICK\b", src) is not None
    if not uses_user and not uses_nick:
        return None, "nothing-to-do"

    eager = EAGER_CAPTURES.findall(src)
    if eager:
        return None, "REFUSED: module-scope NETWORK_NICK capture"

    if uses_user and (seed_names is None or "getSeededVjt" not in seed_names):
        return None, "REFUSED: getSeededVjt used but not imported from seedData"
    if uses_nick and (seed_names is None or "NETWORK_NICK" not in seed_names):
        return None, "REFUSED: NETWORK_NICK used but not imported from seedData"

    remaining = [n for n in seed_names if n not in ("getSeededVjt", "NETWORK_NICK")]
    new_seed = render_import(remaining, SEEDDATA_IMPORT) if remaining else ""

    added = set()
    if uses_user:
        added.add("specUser")
    if uses_nick:
        added.add("specNick")
    new_test = render_import(sorted(set(test_names) | added, key=str.lower), WRAPPED_IMPORT)

    out = src.replace(seed_stmt, new_seed).replace(test_stmt, new_test)
    out = out.replace("getSeededVjt()", "specUser()")
    out = re.sub(r"\bNETWORK_NICK\b", "specNick()", out)
    return out, "ok"


def main():
    apply = "--apply" in sys.argv
    counts = {}
    for path in sorted(TESTS.glob("*.spec.ts")):
        out, status = migrate(path)
        counts[status] = counts.get(status, 0) + 1
        if status.startswith("REFUSED"):
            print(f"  {path.name}: {status}")
        if out and apply:
            path.write_text(out)
    for status, n in sorted(counts.items()):
        print(f"{n:4d}  {status}")


if __name__ == "__main__":
    main()
