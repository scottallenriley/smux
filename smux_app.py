"""PyInstaller entry point for smux.

When frozen:
  smux_app          → launches the UI (connects to or starts the daemon)
  smux_app --daemon → runs the persistent background server
"""
import sys

if "--daemon" in sys.argv:
    from smux.daemon import main
    main()
else:
    from smux.main import main
    main()
