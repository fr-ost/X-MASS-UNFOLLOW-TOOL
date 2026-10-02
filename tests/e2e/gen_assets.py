# Mock X app-shell assets, with the expected animation key computed by the
# independent Python reference implementation (XClientTransaction).
import json, random, base64, sys, bs4
# needs https://github.com/iSarabjitDhiman/XClientTransaction cloned next to this folder
sys.path.insert(0, "../xct-py")
from x_client_transaction.transaction import ClientTransaction
rng = random.Random(77)
key_bytes = [rng.randrange(256) for _ in range(48)]
key = base64.b64encode(bytes(key_bytes)).decode()
frames = []
for f in range(4):
    rows = [[rng.randrange(256) for _ in range(11)] for r in range(16)]
    d = "M 10,30 C" + "C".join(" " + " ".join(f"{v}" if i % 2 else f"{v}," for i, v in enumerate(row)) for row in rows)
    frames.append(f'<svg id="loading-x-anim-{f}" width="0" height="0" style="position:absolute"><g><path d="M0 0"></path><path d="{d}"></path></g></svg>')
idx = [rng.randrange(48) for _ in range(4)]
ondemand = "(self.webpackChunk=self.webpackChunk||[]).push([[20113],{1:function(e,t,n){var a=e;" + ";".join(f"r=parseInt(a[{i}], 16)" for i in idx) + "}}]);"
hash_ = "9f8e7d6c"
frames_html = "".join(frames)
doc = bs4.BeautifulSoup(f'<html><head><meta name="twitter-site-verification" content="{key}"/></head><body>{frames_html}</body></html>', "html.parser")
ct = ClientTransaction(doc, ondemand)
json.dump({"key": key, "framesHtml": frames_html, "ondemand": ondemand, "hash": hash_, "animationKey": ct.animation_key}, open("assets.json", "w"))
print("animationKey", ct.animation_key)
