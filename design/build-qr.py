# Builds the donation QR codes as SVG and proves each one decodes to the exact
# address (rendered to PNG and read back with OpenCV). Run from the repo root.
import io, segno, cv2, numpy as np, sys

WALLETS = {
    "evm": "0x257F291514AaAa1533832cC2C8981Cc14063ED17",
    "sol": "GwwZWYxzms9ebEWQNCAJrPSQdsN6SVPGbpMwCYomWqWa",
    "btc": "bc1qg6clyevlmfekg3rkyhlk5ggeh3g6dnt5sdje4j",
}

ok = True
for name, addr in WALLETS.items():
    qr = segno.make(addr, error="m", micro=False)
    qr.save(f"ui/donate/qr-{name}.svg", scale=6, border=2, dark="#0C1324", light="#FFFFFF", xmldecl=False, svgns=True, title=f"{name.upper()} donation address")
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=8, border=4)
    img = cv2.imdecode(np.frombuffer(buf.getvalue(), np.uint8), cv2.IMREAD_GRAYSCALE)
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    match = text == addr
    ok &= match
    print(f"{name}: version={qr.version} decoded={text!r} match={match}")
sys.exit(0 if ok else 1)
