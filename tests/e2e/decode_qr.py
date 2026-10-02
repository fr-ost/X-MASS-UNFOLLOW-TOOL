# Decodes every PNG given on the command line; prints JSON {file: text}.
import sys, json, cv2
out = {}
for f in sys.argv[1:]:
    img = cv2.imread(f)
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    out[f] = text
print(json.dumps(out))
