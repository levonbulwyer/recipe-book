#!/usr/bin/env python3
"""Recipe Book: a small local server so the app saves straight to your Mac. Python standard library only.

    python3 server.py              start the app at http://localhost:8788
    python3 server.py --backup     write a dated backup and exit

Everything is stored in the "Recipe Book" folder, next to this App folder:
    Data/recipes.db     your live recipe database (SQLite)
    Backups/            one copy per day, the last 30 days are kept

The same App folder also works on GitHub Pages without this server. There it saves in the browser instead.
"""
import argparse
import datetime
import os
import shutil
import signal
import sqlite3
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP = Path(__file__).resolve().parent
ROOT = APP.parent
DATA = ROOT / "Data"
DBPATH = DATA / "recipes.db"
BACKUPS = ROOT / "Backups"
SEED = APP / "recipes.db"
KEEP_BACKUPS = 30
MAX_DB = 200 * 1024 * 1024

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/shop.js": ("shop.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/sql-wasm.js": ("sql-wasm.js", "text/javascript; charset=utf-8"),
    "/sql-wasm.wasm": ("sql-wasm.wasm", "application/wasm"),
}

LOCK = threading.RLock()
STATE = {"rev": 0, "dirty": False}


def ensure_db():
    DATA.mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    if not DBPATH.exists():
        shutil.copyfile(SEED, DBPATH)
        print("Started a new database from the published copy:", DBPATH)
    STATE["rev"] = int(DBPATH.stat().st_mtime_ns)


def looks_like_recipe_db(path):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                return "The database failed its integrity check"
            names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            con.close()
    except sqlite3.DatabaseError as e:
        return "Not a SQLite database: " + str(e)
    missing = {"ingredient", "recipe", "recipe_ingredient", "step", "step_uses", "step_from"} - names
    return ("Missing tables: " + ", ".join(sorted(missing))) if missing else None


def run_backup():
    """One backup per day: today's file is replaced as you keep working. Old ones beyond KEEP_BACKUPS are removed."""
    with LOCK:
        STATE["dirty"] = False
        BACKUPS.mkdir(parents=True, exist_ok=True)
        dest = BACKUPS / f"recipes-{datetime.date.today().isoformat()}.db"
        src = sqlite3.connect(DBPATH)
        try:
            out = sqlite3.connect(dest)
            try:
                src.backup(out)
            finally:
                out.close()
        finally:
            src.close()
        olds = sorted(BACKUPS.glob("recipes-*.db"))
        for p in olds[:-KEEP_BACKUPS]:
            try:
                p.unlink()
            except OSError:
                pass
    return dest


class Handler(BaseHTTPRequestHandler):
    server_version = "RecipeBook/1.0"

    def log_message(self, *args):
        pass

    def send_bytes(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_text(self, code, msg):
        self.send_bytes(code, msg.encode("utf-8"), "text/plain; charset=utf-8")

    def allowed(self, write):
        host = (self.headers.get("Host") or "").lower()
        if host not in self.server.allowed_hosts:
            self.send_text(403, "Host not allowed")
            return False
        if write and self.headers.get("X-Recipe-Book") != "1":
            self.send_text(403, "Missing request header")
            return False
        return True

    def do_GET(self):
        if not self.allowed(False):
            return
        path = urlparse(self.path).path
        if path in STATIC:
            name, ctype = STATIC[path]
            p = APP / name
            if not p.exists():
                return self.send_text(404, "Missing " + name)
            return self.send_bytes(200, p.read_bytes(), ctype)
        if path == "/api/ping":
            return self.send_bytes(200, b'{"ok":true,"mode":"local"}', "application/json",
                                   {"X-Data-Folder": str(DATA).encode("ascii", "replace").decode()})
        if path == "/api/db":
            with LOCK:
                body = DBPATH.read_bytes()
                rev = str(STATE["rev"])
            return self.send_bytes(200, body, "application/x-sqlite3", {"X-Rev": rev})
        if path == "/api/rev":
            return self.send_text(200, str(STATE["rev"]))
        if path == "/recipes.db":
            return self.send_bytes(200, SEED.read_bytes(), "application/x-sqlite3")
        self.send_text(404, "Not found")

    do_HEAD = do_GET

    def do_POST(self):
        if not self.allowed(True):
            return
        path = urlparse(self.path).path
        if path == "/api/backup":
            return self.send_text(200, str(run_backup()))
        if path != "/api/db":
            return self.send_text(404, "Not found")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_DB:
            return self.send_text(400, "The database is empty or too large")
        body = self.rfile.read(length)
        if not body.startswith(b"SQLite format 3\x00"):
            return self.send_text(400, "That is not a SQLite database")
        force = self.headers.get("X-Force") == "1"
        with LOCK:
            if not force and self.headers.get("X-Base-Rev") != str(STATE["rev"]):
                return self.send_bytes(409, b"Changed in another window", "text/plain", {"X-Rev": str(STATE["rev"])})
            tmp = DATA / "recipes.db.saving"
            tmp.write_bytes(body)
            problem = looks_like_recipe_db(tmp)
            if problem:
                tmp.unlink(missing_ok=True)
                return self.send_text(400, problem)
            os.replace(tmp, DBPATH)
            STATE["rev"] = int(DBPATH.stat().st_mtime_ns)
            STATE["dirty"] = True
            rev = str(STATE["rev"])
        self.send_bytes(200, b'{"ok":true}', "application/json", {"X-Rev": rev})


def backup_loop(stop):
    while not stop.wait(600):
        if STATE["dirty"]:
            try:
                run_backup()
            except Exception as e:  # keep the server running
                print("Backup failed:", e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (default: this computer only)")
    ap.add_argument("--allow-host", action="append", default=[], help="extra Host header to accept")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--backup", action="store_true")
    args = ap.parse_args()

    ensure_db()
    if args.backup:
        print("Backup saved:", run_backup())
        return

    httpd = None
    for port in range(args.port, args.port + 10):
        try:
            httpd = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError:
            continue
    if not httpd:
        sys.exit(f"Ports {args.port}-{args.port + 9} are all in use. Close the other Recipe Book window and try again.")
    httpd.daemon_threads = True
    httpd.allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}"} | {h.lower() for h in args.allow_host}

    url = f"http://localhost:{port}/"
    print(f"Recipe Book is running at {url}")
    print(f"Your recipes are saved in: {DBPATH}")
    print("Leave this window open while you use it. Press Control-C to stop.")
    try:
        print("Backup saved:", run_backup())
    except Exception as e:
        print("Backup failed:", e)

    stop = threading.Event()
    threading.Thread(target=backup_loop, args=(stop,), daemon=True).start()

    def on_signal(*_):
        raise KeyboardInterrupt

    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, on_signal)

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()
        if STATE["dirty"]:
            try:
                print("Final backup:", run_backup())
            except Exception as e:
                print("Backup failed:", e)
        print("Recipe Book stopped.")


if __name__ == "__main__":
    main()
