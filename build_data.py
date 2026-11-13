# -*- coding: utf-8 -*-
"""把路線與棒次資料轉成 app 用的 app\\data.js。

用法（在專案根目錄）：
    py app\\build_data.py

來源：
    route\\crufu_east_2027_official.gpx   路線軌跡＋高度（build_official.py 由大會我的地圖產生）
    route\\legs_2027_official.csv         各棒公里數、座標、隧道、大會接力區說明
    route\\legs_2027_difficulty.csv       各棒難度與原因（leg_difficulty.py 產生）
大會改了我的地圖：先跑 py route\\build_official.py --fetch 與 py route\\leg_difficulty.py，再跑本檔。
"""
import csv
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
ROUTE = ROOT / "route"


def main():
    gpx = (ROUTE / "crufu_east_2027_official.gpx").read_text(encoding="utf-8")
    pts = [(float(a), float(b), float(e)) for a, b, e in
           re.findall(r'<trkpt lat="([\d.]+)" lon="([\d.]+)"><ele>([-\d.]+)</ele>', gpx)]
    base = {r["leg"]: r for r in csv.DictReader(open(ROUTE / "legs_2027_official.csv", encoding="utf-8-sig"))}
    # GPX 點是沿路線每 200 m 取樣（build_route.py 的 SAMPLE_M），直接用取樣間距當里程；
    # 用點對點直線距離會切彎道而偏短。最後一點對齊棒次表的總長
    total = float(base[str(len(base))]["end_km"])
    track = []
    for i, p in enumerate(pts):
        km = total if i == len(pts) - 1 else min(i * 0.2, total)
        track.append([round(p[0], 5), round(p[1], 5), round(km, 3), round(p[2])])
    km = total
    legs = []
    for r in csv.DictReader(open(ROUTE / "legs_2027_difficulty.csv", encoding="utf-8-sig")):
        b = base[r["棒次"]]
        legs.append({
            "n": int(r["棒次"]), "startKm": float(b["start_km"]), "endKm": float(b["end_km"]),
            "km": float(b["distance_km"]), "gain": int(b["gain_m"]), "loss": int(b["loss_m"]),
            "level": r["難度"], "reason": r["原因"], "tunnel": b["has_tunnel"] == "Y",
            "start": [float(b["start_lat"]), float(b["start_lon"])],
            "end": [float(b["end_lat"]), float(b["end_lon"])],
            "relayNote": b["official_note"],
        })

    data = {
        "event": "2027 CRUFU RUN 東臺灣站",
        "planStart": "2027-04-10T06:30:00+08:00",   # 抽籤梯次公布後可在 app 設定裡改
        "nightStart": "2027-04-10T17:00:00+08:00",
        "nightEnd": "2027-04-11T07:00:00+08:00",
        "cutoff": "2027-04-11T13:00:00+08:00",
        "routeNote": "大會 Google 我的地圖路線＋30 個官方接力區（2026-11-05 公布；開門時間以活動手冊為準）",
        "totalKm": round(km, 2), "track": track, "legs": legs,
    }
    out = Path(__file__).resolve().parent / "data.js"
    out.write_text("// 由 app/build_data.py 產生，請勿手動修改\nwindow.CRUFU_DATA = "
                   + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"完成：{out.name}，軌跡 {len(track)} 點、{len(legs)} 棒、全長 {km:.1f} km，{out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
