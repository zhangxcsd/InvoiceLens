"""生成 InvoiceLens 授权 RSA 密钥对（开发/签发用）。

公钥写入 config/license_public.pem（随包分发）；私钥默认写入 scripts/.license_private.pem（勿提交仓库）。
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成授权 RSA 密钥对")
    parser.add_argument(
        "--private-out",
        type=Path,
        default=ROOT / "scripts" / ".license_private.pem",
        help="私钥输出路径",
    )
    parser.add_argument(
        "--public-out",
        type=Path,
        default=ROOT / "config" / "license_public.pem",
        help="公钥输出路径",
    )
    args = parser.parse_args(argv)

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        print("请先安装: pip install cryptography")  # noqa: T201
        return 1

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    args.private_out.parent.mkdir(parents=True, exist_ok=True)
    args.public_out.parent.mkdir(parents=True, exist_ok=True)
    args.private_out.write_bytes(private_pem)
    args.public_out.write_bytes(public_pem)
    print(f"私钥: {args.private_out}")  # noqa: T201
    print(f"公钥: {args.public_out}")  # noqa: T201
    print("签发授权: python scripts/sign_license.py --private-key <私钥> --out data/config/license.lic")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
