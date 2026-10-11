#!/usr/bin/env python3
"""CAD CLI. stdout is exactly one JSON response; exit 2 represents structured failure."""
from __future__ import annotations

import argparse
import contextlib
import json
import sys
from pathlib import Path

from assembly import export_assembly
from engine import CadError, evaluate_checks, execute_plan, export_part, export_views, patch_plan, resolve, write_json
from import_asset import import_asset


def run(operation, payload, output):
    if operation == "compare_views":
        from compare import compare_views
        return compare_views(payload, output)
    if operation == "import":
        return import_asset(payload, output)
    if operation == "build":
        return export_part(payload, output)
    if operation == "assembly":
        return export_assembly(payload, output)
    if operation == "patch":
        plan = patch_plan(payload)
        result = export_part(plan, output)
        result["operation"] = "patch"
        result["patches"] = payload.get("patches", [])
        result["parameter_patches"] = payload.get("parameters", {})
        result["rebuild_strategy"] = "Re-execute the ordered feature plan; stable feature IDs preserve patch targets. Incremental kernel caching is not implemented."
        write_json(Path(output) / "manifest.json", result)
        return result
    shape, log = execute_plan(payload)
    if operation == "validate":
        result = {"status": "completed", "operation": operation, "verification": evaluate_checks(shape, resolve(payload.get("checks", []), payload.get("parameters", {}))), "feature_log": log, "errors": []}
    elif operation == "project":
        result = {"status": "completed", "operation": operation, "files": {"views": export_views(shape, Path(output) / "views"), "view_metadata": str(Path(output).resolve() / "views" / "metadata.json")}, "errors": []}
        if payload.get("checks"):
            result["verification"] = evaluate_checks(shape, resolve(payload["checks"], payload.get("parameters", {})))
    else:
        raise CadError("UNKNOWN_OPERATION", f"Unsupported operation: {operation}.")
    write_json(Path(output) / "manifest.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["build", "validate", "project", "patch", "assembly", "import", "compare_views"])
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.input.stat().st_size > 5_000_000:
            raise CadError("RESOURCE_LIMIT", "Input JSON exceeds 5 MB.")
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        # OpenCascade can emit text on stderr; keep application stdout machine readable.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(args.operation, payload, args.output)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        error = exc.as_dict() if isinstance(exc, CadError) else {"code": "INVALID_INPUT" if isinstance(exc, (ValueError, KeyError, TypeError, OSError)) else "CAD_ERROR", "message": str(exc), "feature_id": None}
        result = {"schema_version": "1.0", "status": "failed", "operation": args.operation, "errors": [error]}
        write_json(args.output / "manifest.json", result)
        print(json.dumps(result, ensure_ascii=False))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
