"""CITY//SHIFT backend package."""

from cityshift.systemcerts import use_system_certs

__version__ = "0.1.0"

use_system_certs()  # trust OS-installed roots so https works behind a TLS-inspecting proxy
