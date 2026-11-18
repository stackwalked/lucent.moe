import json

import pytest
from ts_hygiene import check_filename, check_package_json


@pytest.mark.parametrize(
    "deps",
    [
        {"zod": "4.6.7", "@lucent/server": "workspace:*"},
        {"hono": "4.13.19-rc.1"},
    ],
)
def test_accepts_exact_pins_and_workspace_protocol(deps: dict[str, str]) -> None:
    payload = json.dumps({"dependencies": deps})
    assert check_package_json("platform/server/package.json", payload) == []


@pytest.mark.parametrize(
    "bad_spec",
    ["^4.6.7", "~4.6.7", "*", ">=1.0.0", "latest", "workspace:^"],
)
def test_rejects_version_ranges(bad_spec: str) -> None:
    payload = json.dumps({"devDependencies": {"zod": bad_spec}})
    findings = check_package_json("package.json", payload)
    assert len(findings) == 1
    assert "must be an exact version" in findings[0]


@pytest.mark.parametrize(
    "rel_path",
    [
        "platform/server/src/core/utils.ts",
        "platform/server/src/authority/helpers.ts",
        "web/src/ui/common.tsx",
        "contracts/v1/types.ts",
    ],
)
def test_rejects_junk_drawer_filenames(rel_path: str) -> None:
    finding = check_filename(rel_path)
    assert finding is not None
    assert "junk-drawer filename" in finding


@pytest.mark.parametrize(
    "rel_path",
    [
        "platform/server/src/core/result.ts",
        "platform/server/src/authority/policy.ts",
        "tools/lint/utils.py",
    ],
)
def test_accepts_domain_named_files(rel_path: str) -> None:
    assert check_filename(rel_path) is None
