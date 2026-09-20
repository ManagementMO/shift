"""Verify TLS against the OS trust store instead of certifi's bundle.

httpx/urllib3 ship with certifi, which only contains public roots.  On a machine behind a
TLS-inspecting corporate proxy every https call then dies with

    [SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate chain

because the proxy re-signs the chain with a private root that is installed in the OS keychain
but absent from certifi.  `truststore` makes `ssl` read the OS store (macOS Keychain, Windows
CryptoAPI, OpenSSL dirs on Linux), so the proxy root is trusted and public roots still are too --
no verification is disabled.  Imported by `cityshift/__init__`, so every entry point gets it.

Set CITYSHIFT_SYSTEM_CERTS=0 to keep the certifi behaviour.
"""

from __future__ import annotations

import os

_injected = False


def use_system_certs() -> bool:
    """Idempotent; returns whether the OS trust store is now in effect."""
    global _injected
    if _injected:
        return True
    if os.environ.get("CITYSHIFT_SYSTEM_CERTS", "1") == "0":
        return False
    try:
        import truststore
    except ImportError:  # optional dependency; certifi bundle stays in use
        return False
    truststore.inject_into_ssl()
    _injected = True
    return True
