"""Resume the saved BYOK gateway with the verified localmodels kit."""

import json
import sys
from typing import Literal

from localmodels import (
    bifrost_config,
    bifrost_datasheet,
    gateway_bifrost,
    hosts,
    library_gateway,
    source_byok,
)
from localmodels.__main__ import main
from localmodels.library_model import LibraryError


def restore_saved_gateway() -> Literal["restored", "skipped", "apply"]:
    """Restore an owned gateway or defer to source apply when its base is missing."""
    with library_gateway.gateway_locked():
        source = source_byok.load_source_state()
        if source is None:
            raise source_byok.ByokError("BYOK_INVALID_CONFIG", "Saved model source is missing or invalid.")
        if source["mode"] != "byok":
            return "skipped"
        record = library_gateway.ensure_instance(None)
        if not record or source["gateway_url"] != "http://" + record["addr"]:
            return "apply"
        addr = record["addr"]
        gateway_bifrost.require_target(
            {"tools_dir": hosts.tools_dir(), "tools": [{"tool": "gateway", "path": addr}]}
        )
        app = gateway_bifrost.app_dir()
        config = bifrost_config.read_config(app)
        if not config:
            return "apply"
        creds = source_byok.load_credentials()
        if not creds:
            raise source_byok.ByokError("BYOK_INVALID_CONFIG", "Saved BYOK credentials are missing.")

        provider = source_byok.BYOK_PROVIDER
        model = creds["model_id"]
        config.setdefault("providers", {})[provider] = source_byok.render_byok_provider(creds)
        governance = config.setdefault("governance", {})
        rules = governance.get("routing_rules") or []
        governance["routing_rules"] = [
            rule for rule in rules if rule.get("id") != bifrost_config.BYOK_RULE
        ] + [bifrost_config.byok_rule(model)]
        sheet = {
            name: row for name, row in library_gateway.read_sheet(app).items()
            if not name.startswith(f"{provider}/")
        }
        byok_sheets = bifrost_datasheet.sheets(
            provider, [model, source_byok.BYOK_MODEL], creds["context_window"]
        )
        sheet.update(byok_sheets[bifrost_datasheet.DATASHEET])

        # apply_config waits for local health. The setup-only /v1/models check
        # can block on a provider that accepts connections before it is ready.
        library_gateway.apply_config(record, config, sheet)
        source_byok.write_byok_profiles(addr, creds)
        return "restored"


if __name__ == "__main__":
    try:
        outcome = restore_saved_gateway()
    except (LibraryError, OSError, ValueError, RuntimeError, KeyError) as error:
        print(json.dumps({"code": getattr(error, "code", "BYOK_GATEWAY_FAILED"), "message": str(error)}))
        sys.exit(1)
    if outcome == "apply":
        sys.exit(main())
    print(json.dumps({"restore": outcome}))
