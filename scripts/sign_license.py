"""使用 RSA 私钥签发 .lic 授权文件。"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_LICENSE_KEYS = (
    "tier",
    "customer",
    "expires_at",
    "max_entities",
    "max_invoices",
    "max_years",
    "export_report",
    "cross_group",
)


def _canonical_bytes(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign_payload(payload: dict, private_key_path: Path) -> dict:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    pem = private_key_path.read_bytes()
    private_key = serialization.load_pem_private_key(pem, password=None)
    sig = private_key.sign(
        _canonical_bytes(payload),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
        hashes.SHA256(),
    )
    return {"payload": payload, "signature": base64.b64encode(sig).decode("ascii")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="签发 InvoiceLens .lic 授权")
    parser.add_argument("--private-key", type=Path, default=ROOT / "scripts" / ".license_private.pem")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "config" / "license.lic")
    parser.add_argument("--payload", type=str, default="", help="JSON 授权字段；省略则用试用升级示例")
    args = parser.parse_args(argv)

    if not args.private_key.is_file():
        print(f"缺少私钥: {args.private_key}，请先运行 scripts/gen_license_keys.py")  # noqa: T201
        return 1

    if args.payload.strip():
        raw = json.loads(args.payload)
        if not isinstance(raw, dict):
            raise SystemExit("payload 须为 JSON 对象")
        payload = {k: raw[k] for k in _LICENSE_KEYS if k in raw}
    else:
        payload = {
            "tier": "pro",
            "customer": "smoke-customer",
            "expires_at": "2099-12-31",
            "max_entities": 99,
            "max_invoices": 500000,
            "max_years": 5,
            "export_report": True,
            "cross_group": True,
        }

    doc = sign_payload(payload, args.private_key)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入: {args.out}")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
