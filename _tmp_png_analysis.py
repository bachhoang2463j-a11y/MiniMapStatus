import sys
from PIL import Image
import collections

paths = {
    "city_flat": r"C:\Users\ELevin\.zcode\cli\artifacts\sess_99611eeb-cbd7-4a24-a379-ab66027f674d\call_c4dc04867e6240b2876fb6e6-tool-result-0cd81500-db84-4a08-bf25-d4a11f1d6947.png",
    "city_parch": r"C:\Users\ELevin\.zcode\cli\artifacts\sess_99611eeb-cbd7-4a24-a379-ab66027f674d\call_37980ae1624f4f33adf8d5a4-tool-result-6236d8ac-ecee-42df-857c-6a6496d33d14.png",
    "world_flat": r"C:\Users\ELevin\.zcode\cli\artifacts\sess_99611eeb-cbd7-4a24-a379-ab66027f674d\call_1dbc4c3e3a504b159aa3a82f-tool-result-1dca1fb6-3c2f-4311-bdef-2afab40e47d2.png",
}

for name, p in paths.items():
    im = Image.open(p)
    print(f"=== {name} ===")
    print("size:", im.size, "mode:", im.mode)
    rgb = im.convert("RGB")
    w, h = rgb.size
    # sample every 4th pixel for speed
    cnt = collections.Counter()
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            cnt[rgb.getpixel((x, y))] += 1
    total = sum(cnt.values())
    print("unique sampled colors:", len(cnt))
    print("top 12 colors:")
    for c, n in cnt.most_common(12):
        print(f"   {c}  {n/total*100:.2f}%")
    # row-uniformity check: fraction of rows that are nearly single color (possible blank bands)
    import statistics
    blank_rows = 0
    for y in range(0, h, 2):
        row = [rgb.getpixel((x, y)) for x in range(0, w, 8)]
        rs = [c[0] for c in row]; gs = [c[1] for c in row]; bs = [c[2] for c in row]
        if statistics.pstdev(rs) < 4 and statistics.pstdev(gs) < 4 and statistics.pstdev(bs) < 4:
            blank_rows += 1
    print(f"near-uniform rows (sampled): {blank_rows}/{len(range(0,h,2))}")
    print()
