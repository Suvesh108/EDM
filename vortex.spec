# -*- mode: python ; coding: utf-8 -*-

import os
import sys

block_cipher = None

added_files = [
    ('backend/static', 'backend/static'),
    ('backend/templates', 'backend/templates'),
    ('backend/static', 'static'),
    ('backend/templates', 'templates'),
    ('vortex.ico', '.')
]

hidden_imports = [
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'app',
    'database',
    'logger',
    'keepalive',
    'torrent_manager',
    'engine',
    'engine.chunk_downloader',
    'engine.detector',
    'engine.hosts_extractor',
    'engine.integrations',
    'engine.queue_manager',
    'engine.yt_extractor',
    'accounts',
    'accounts.account_manager',
    'exporters',
    'exporters.export_manager',
    'curl_cffi',
    'curl_cffi.requests',
    'yt_dlp',
    'yt_dlp.extractor',
    'jinja2',
    'starlette',
    'fastapi',
    'pydantic',
    'httpx',
    'sqlite3'
]

a = Analysis(
    ['run.py'],
    pathex=['.', 'backend'],
    binaries=[],
    datas=added_files,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'scipy', 'pandas', 'IPython'],
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
    name='VortexDownloader',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='vortex.ico'
)
