"""Cold-start probe: time until /v1/models responds and until first completion token.

Start this job right after `ALTER SERVICE ... RESUME` (or a scale-up). t0 is the
probe start; the SQL driver also records the RESUME timestamp so total cold start
= (resume -> probe start) + probe-measured time.
"""
import argparse, json, time, urllib.request, urllib.error

p = argparse.ArgumentParser()
p.add_argument("--base-url", required=True)
p.add_argument("--model", required=True)
p.add_argument("--out", required=True)
p.add_argument("--run-id", default="")
p.add_argument("--timeout", type=int, default=3600)
p.add_argument("--interval", type=float, default=2.0)
a = p.parse_args()

def call(path, body=None, timeout=10):
    req = urllib.request.Request(a.base_url.rstrip("/") + path,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

t0 = time.time()
res = {"run_id": a.run_id, "probe_start_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0))}

while time.time() - t0 < a.timeout:
    try:
        call("/v1/models"); res["models_ready_s"] = round(time.time() - t0, 2); break
    except (urllib.error.URLError, OSError, TimeoutError):
        time.sleep(a.interval)

if "models_ready_s" in res:
    t1 = time.time()
    call("/v1/completions", {"model": a.model, "prompt": "Hello", "max_tokens": 1}, timeout=600)
    res["first_completion_s"] = round(time.time() - t0, 2)
    res["first_completion_latency_s"] = round(time.time() - t1, 2)
else:
    res["error"] = "timeout"

json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=2)
print(res)
