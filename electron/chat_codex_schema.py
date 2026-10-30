"""Structural validation using the CLI-generated, version-pinned schema subset."""

import json
from pathlib import Path
import re

BUNDLE = json.loads(Path(__file__).with_name("chat-codex-schema.json").read_text())
SUPPORTED_VERSIONS = (BUNDLE["version"], *BUNDLE.get("versions", {}))


def validate_native(name, value, version=None):
    version = version or BUNDLE["version"]
    if version not in SUPPORTED_VERSIONS:
        raise ValueError("Unsupported Codex protocol version: " + str(version))
    schemas = BUNDLE["schemas"] if version == BUNDLE["version"] else {**BUNDLE["schemas"], **BUNDLE["versions"][version]}
    root = schemas[name]

    def check(schema, item, depth=0):
        if depth > 100:
            return False
        if isinstance(schema, bool):
            return schema
        if "$ref" in schema:
            return check(root["definitions"][schema["$ref"].removeprefix("#/definitions/")], item, depth + 1)
        for key in ("allOf", "anyOf", "oneOf"):
            if key in schema:
                matches = sum(check(part, item, depth + 1) for part in schema[key])
                if (key == "allOf" and matches != len(schema[key])) or (key == "anyOf" and not matches) or (key == "oneOf" and matches != 1):
                    return False
        if "enum" in schema and item not in schema["enum"]:
            return False
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            matches = dict(null=item is None, boolean=type(item) is bool, integer=type(item) is int, number=type(item) in (int, float), string=isinstance(item, str), array=isinstance(item, list), object=isinstance(item, dict))
            if not any(matches.get(kind, False) for kind in types):
                return False
        if isinstance(item, dict):
            properties = schema.get("properties", {})
            if set(schema.get("required", [])) - set(item):
                return False
            for key, val in item.items():
                target = properties.get(key, schema.get("additionalProperties", True))
                if not check(target, val, depth + 1):
                    return False
        if isinstance(item, list):
            if len(item) < schema.get("minItems", 0) or len(item) > schema.get("maxItems", float("inf")):
                return False
            if "items" in schema and not all(check(schema["items"], val, depth + 1) for val in item):
                return False
        if isinstance(item, str):
            if len(item) < schema.get("minLength", 0) or len(item) > schema.get("maxLength", float("inf")):
                return False
            if "pattern" in schema and not re.search(schema["pattern"], item):
                return False
        if type(item) in (int, float) and not schema.get("minimum", -float("inf")) <= item <= schema.get("maximum", float("inf")):
            return False
        return True

    if not check(root, value):
        raise ValueError("Invalid Codex " + name + " payload")
    return value
