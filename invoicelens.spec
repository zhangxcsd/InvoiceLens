# -*- mode: python ; coding: utf-8 -*-
"""InvoiceLens 离线打包 spec（PyInstaller）。

用法见 docs/packaging.md
"""
from pathlib import Path

block_cipher = None
ROOT = Path(SPECPATH)

a = Analysis(
    [str(ROOT / 'scripts' / 'run_packaged_app.py')],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        (str(ROOT / 'config'), 'config'),
        (str(ROOT / 'assets'), 'assets'),
        (str(ROOT / 'frontend' / 'dist'), 'frontend/dist'),
    ],
    hiddenimports=[
        'duckdb',
        'polars',
        'pandas',
        'plotly',
        'yaml',
        'openpyxl',
        'xlrd',
        'docx',
        'pypinyin',
        'cryptography',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['streamlit'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='InvoiceLens',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
