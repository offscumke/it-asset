#!/usr/bin/env python3
"""
IT Asset Agent - Windows & macOS
用法: it-asset-agent --server http://SERVER:3001 --agent-secret YOUR_SECRET
"""
import argparse, json, os, platform, socket, subprocess, sys, time, urllib.request

def get_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"

def get_mac():
    try:
        import uuid as _u
        mac = _u.getnode()
        return ':'.join(f'{(mac>>(5-i)*8)&0xff:02x}' for i in range(6))
    except Exception:
        return ""

def get_cpu_info():
    try:
        import psutil
        return {"cpu": platform.processor() or "Unknown", "cpu_cores": psutil.cpu_count(logical=True)}
    except ImportError:
        return {"cpu": platform.processor() or "Unknown", "cpu_cores": os.cpu_count() or 1}

def get_memory():
    try:
        import psutil
        m = psutil.virtual_memory()
        return {"ram_total": m.total, "ram_free": m.available}
    except ImportError:
        return {"ram_total": 0, "ram_free": 0}

def get_disk():
    try:
        import psutil
        d = psutil.disk_usage('C:\\' if sys.platform == 'win32' else '/')
        return {"disk_total": d.total, "disk_free": d.free}
    except ImportError:
        return {"disk_total": 0, "disk_free": 0}

def get_software_windows():
    apps = []
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for path in (
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            ):
                try:
                    key = winreg.OpenKey(hive, path)
                    for i in range(winreg.QueryInfoKey(key)[0]):
                        try:
                            sub = winreg.OpenKey(key, winreg.EnumKey(key, i))
                            name = winreg.QueryValueEx(sub, "DisplayName")[0]
                            try: ver = winreg.QueryValueEx(sub, "DisplayVersion")[0]
                            except: ver = ""
                            if name: apps.append({"name": name, "version": ver})
                        except: pass
                except: pass
    except: pass
    return apps

def get_software_macos():
    apps = []
    try:
        result = subprocess.run(
            ['find', '/Applications', '-maxdepth', '2', '-name', '*.app', '-prune'],
            capture_output=True, text=True, timeout=30)
        for line in result.stdout.strip().splitlines():
            name = os.path.basename(line).replace('.app', '')
            ver = ""
            plist = os.path.join(line, 'Contents', 'Info.plist')
            if os.path.exists(plist):
                try:
                    r2 = subprocess.run(
                        ['/usr/bin/defaults', 'read', plist, 'CFBundleShortVersionString'],
                        capture_output=True, text=True, timeout=5)
                    ver = r2.stdout.strip()
                except: pass
            apps.append({"name": name, "version": ver})
    except: pass
    try:
        result = subprocess.run(['brew', 'list', '--versions'],
            capture_output=True, text=True, timeout=30)
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts: apps.append({"name": parts[0], "version": parts[1] if len(parts)>1 else ""})
    except: pass
    return apps

def collect_info(vnc_port):
    plat = sys.platform
    info = {
        "hostname": socket.gethostname(),
        "platform": "darwin" if plat == "darwin" else "windows",
        "ip": get_ip(),
        "mac_address": get_mac(),
        "os": platform.system(),
        "os_version": platform.version(),
        "vnc_port": vnc_port,
    }
    info.update(get_cpu_info())
    info.update(get_memory())
    info.update(get_disk())
    info["software"] = get_software_windows() if plat == "win32" else get_software_macos()
    return info

def checkin(server_url, data, agent_secret):
    payload = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{server_url.rstrip('/')}/api/checkin",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer agent:{agent_secret}"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def main():
    parser = argparse.ArgumentParser(description="IT Asset Agent")
    parser.add_argument("--server", default="http://localhost:3001")
    parser.add_argument("--agent-secret", required=True)
    parser.add_argument("--interval", type=int, default=300)
    parser.add_argument("--vnc-port", type=int, default=5900)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    print(f"[Agent] Server: {args.server} | Interval: {args.interval}s | VNC: {args.vnc_port}")
    while True:
        try:
            info = collect_info(args.vnc_port)
            result = checkin(args.server, info, args.agent_secret)
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] OK — id:{result.get('id','?')} sw:{len(info['software'])}")
        except Exception as e:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] FAILED: {e}")
        if args.once:
            break
        time.sleep(args.interval)

if __name__ == "__main__":
    main()
