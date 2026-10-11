"""Generate the judge-facing demo drawings (vector PDF with a text layer, plus PNG previews).

The drawings are original, fully dimensioned test inputs. Reference values live only in
cases.json under "reference" for the evaluation side; the model receives the drawing alone.
"""
from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcParams["pdf.fonttype"] = 42  # Embed TrueType so the PDF text layer is extractable.
matplotlib.rcParams["font.family"] = "DejaVu Sans"
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Rectangle

OUT = Path(__file__).resolve().parents[2] / "assets" / "demo-cases"
LINE = dict(color="black", linewidth=0.7)
THIN = dict(color="black", linewidth=0.35)
CENTRE = dict(color="#555555", linewidth=0.3, linestyle=(0, (8, 2, 1.5, 2)))
HIDDEN = dict(color="black", linewidth=0.35, linestyle=(0, (3, 1.5)))


def sheet(code: str, title: str, material: str, scale: str = "1:1"):
    fig = plt.figure(figsize=(297 / 25.4, 210 / 25.4))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 297)
    ax.set_ylim(0, 210)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.add_patch(Rectangle((10, 10), 277, 190, fill=False, **LINE))
    ax.add_patch(Rectangle((187, 10), 100, 34, fill=False, **LINE))
    for y in (21, 32):
        ax.plot([187, 287], [y, y], **THIN)
    ax.text(190, 36.5, f"{code}   {title}", fontsize=9, weight="bold", va="center")
    ax.text(190, 26.5, f"UNITS: mm    SCALE {scale}    MATERIAL: {material}", fontsize=6.5, va="center")
    ax.text(190, 15.5, "EngineerAgent demo case - original test drawing", fontsize=6, va="center")
    return fig, ax


def arrow(ax, tip, direction, size=2.2):
    dx, dy = direction
    norm = math.hypot(dx, dy)
    dx, dy = dx / norm, dy / norm
    px, py = -dy, dx
    base = (tip[0] - dx * size, tip[1] - dy * size)
    ax.fill([tip[0], base[0] + px * size * 0.3, base[0] - px * size * 0.3],
            [tip[1], base[1] + py * size * 0.3, base[1] - py * size * 0.3], color="black", linewidth=0)


def hdim(ax, x1, x2, y, label, ext_from=None, text_dy=1.6):
    """Horizontal dimension at height y; extension lines drop to ext_from (y of the feature)."""
    if ext_from is not None:
        for x in (x1, x2):
            ax.plot([x, x], [ext_from + (1 if y > ext_from else -1), y + (1.5 if y > ext_from else -1.5)], **THIN)
    ax.plot([x1, x2], [y, y], **THIN)
    arrow(ax, (x1, y), (-1, 0))
    arrow(ax, (x2, y), (1, 0))
    ax.text((x1 + x2) / 2, y + text_dy, label, fontsize=8, ha="center", va="bottom")


def vdim(ax, y1, y2, x, label, ext_from=None):
    if ext_from is not None:
        for y in (y1, y2):
            ax.plot([ext_from + (1 if x > ext_from else -1), x + (1.5 if x > ext_from else -1.5)], [y, y], **THIN)
    ax.plot([x, x], [y1, y2], **THIN)
    arrow(ax, (x, y1), (0, -1))
    arrow(ax, (x, y2), (0, 1))
    ax.text(x - 1.6, (y1 + y2) / 2, label, fontsize=8, ha="right", va="center", rotation=90)


def centre_mark(ax, x, y, r):
    ax.plot([x - r - 2.5, x + r + 2.5], [y, y], **CENTRE)
    ax.plot([x, x], [y - r - 2.5, y + r + 2.5], **CENTRE)


def plate(code: str, title: str, thickness: str | None):
    L, W, T = 120, 80, 12
    pitch_x, pitch_y, hole_d, bore_d = 96, 56, 10, 30
    fig, ax = sheet(code, title, "6061-T6 (reference only)")
    x0, y0 = 45, 92  # top view lower-left
    cx, cy = x0 + L / 2, y0 + W / 2
    ax.text(x0, y0 - 9, "TOP VIEW", fontsize=7.5)
    ax.add_patch(Rectangle((x0, y0), L, W, fill=False, **LINE))
    ax.plot([x0 - 6, x0 + L + 6], [cy, cy], **CENTRE)
    ax.plot([cx, cx], [y0 - 6, y0 + W + 6], **CENTRE)
    for sx in (-1, 1):
        for sy in (-1, 1):
            hx, hy = cx + sx * pitch_x / 2, cy + sy * pitch_y / 2
            ax.add_patch(Circle((hx, hy), hole_d / 2, fill=False, **LINE))
            centre_mark(ax, hx, hy, hole_d / 2)
    ax.add_patch(Circle((cx, cy), bore_d / 2, fill=False, **LINE))
    hdim(ax, x0, x0 + L, y0 + W + 20, "120", ext_from=y0 + W)
    hdim(ax, cx - pitch_x / 2, cx + pitch_x / 2, y0 + W + 9, "96", ext_from=cy + pitch_y / 2 + hole_d / 2)
    vdim(ax, y0, y0 + W, x0 - 12, "80", ext_from=x0)
    vdim(ax, cy - pitch_y / 2, cy + pitch_y / 2, x0 + L + 14, "56", ext_from=cx + pitch_x / 2 + hole_d / 2)
    # Leaders for the hole callouts.
    hx, hy = cx + pitch_x / 2, cy + pitch_y / 2
    ax.plot([hx + 3.5, hx + 24], [hy + 3.5, hy + 22], **THIN)
    ax.plot([hx + 24, hx + 50], [hy + 22, hy + 22], **THIN)
    ax.text(hx + 25, hy + 23, "4 x Ø10 THRU", fontsize=8, va="bottom")
    ax.plot([cx + 14.1, cx + 28], [cy + 5.1, cy + 12], **THIN)
    ax.plot([cx + 28, cx + 44], [cy + 12, cy + 12], **THIN)
    ax.text(cx + 28.5, cy + 13, "Ø30 THRU", fontsize=8, va="bottom")
    # Front view below the top view, aligned in X.
    fy = 52
    ax.text(x0, fy - 9, "FRONT VIEW", fontsize=7.5)
    ax.add_patch(Rectangle((x0, fy), L, T, fill=False, **LINE))
    for hxp in (cx - pitch_x / 2, cx + pitch_x / 2):
        for edge in (-hole_d / 2, hole_d / 2):
            ax.plot([hxp + edge] * 2, [fy, fy + T], **HIDDEN)
        ax.plot([hxp, hxp], [fy - 3, fy + T + 3], **CENTRE)
    for edge in (-bore_d / 2, bore_d / 2):
        ax.plot([cx + edge] * 2, [fy, fy + T], **HIDDEN)
    ax.plot([cx, cx], [fy - 3, fy + T + 3], **CENTRE)
    if thickness is None:
        ax.plot([x0 + L + 2, x0 + L + 16], [fy + T / 2, fy + T / 2], **THIN)
        ax.text(x0 + L + 17, fy + T / 2, "THICKNESS: ?", fontsize=8, va="center")
    else:
        vdim(ax, fy, fy + T, x0 + L + 12, thickness, ext_from=x0 + L)
    notes = ["NOTES:", "1. All holes through, symmetric about both centrelines.",
             "2. Square corners, no chamfers or fillets.", "3. Do not scale; use printed dimensions only."]
    if thickness is None:
        notes.append("4. Plate thickness to be confirmed by customer.")
    for i, line in enumerate(notes):
        ax.text(192, 120 - i * 6.5, line, fontsize=7 if i else 7.5, weight="bold" if not i else "normal")
    return fig


def flange(code: str, title: str):
    D, T, bore_d, pcd, hole_d, n = 140, 16, 60, 110, 14, 6
    fig, ax = sheet(code, title, "Q235 (reference only)")
    cx, cy = 100, 116
    ax.text(cx - 12, cy - D / 2 - 8, "TOP VIEW", fontsize=7.5)
    ax.add_patch(Circle((cx, cy), D / 2, fill=False, **LINE))
    ax.add_patch(Circle((cx, cy), bore_d / 2, fill=False, **LINE))
    ax.add_patch(Circle((cx, cy), pcd / 2, fill=False, **CENTRE))
    ax.plot([cx - D / 2 - 6, cx + D / 2 + 6], [cy, cy], **CENTRE)
    ax.plot([cx, cx], [cy - D / 2 - 6, cy + D / 2 + 6], **CENTRE)
    for i in range(n):
        a = math.radians(360 * i / n)
        hx, hy = cx + pcd / 2 * math.cos(a), cy + pcd / 2 * math.sin(a)
        ax.add_patch(Circle((hx, hy), hole_d / 2, fill=False, **LINE))
    # Diameter callouts with leaders.
    def callout(angle_deg, radius, text, length=18):
        a = math.radians(angle_deg)
        px, py = cx + radius * math.cos(a), cy + radius * math.sin(a)
        ex, ey = cx + (D / 2 + 10) * math.cos(a), cy + (D / 2 + 10) * math.sin(a)
        arrow(ax, (px, py), (px - ex, py - ey))
        ax.plot([px, ex], [py, ey], **THIN)
        sign = 1 if math.cos(a) >= 0 else -1
        ax.plot([ex, ex + sign * length], [ey, ey], **THIN)
        ax.text(ex + sign * 1.5, ey + 1, text, fontsize=8, ha="left" if sign > 0 else "right", va="bottom")
    callout(135, D / 2, "Ø140")
    callout(225, bore_d / 2, "Ø60 THRU", length=20)
    hx, hy = cx + pcd / 2 * math.cos(math.radians(60)), cy + pcd / 2 * math.sin(math.radians(60))
    ax.plot([hx + 4.5, hx + 20], [hy + 4.5, hy + 20], **THIN)
    ax.plot([hx + 20, hx + 58], [hy + 20, hy + 20], **THIN)
    ax.text(hx + 21, hy + 21, "6 x Ø14 THRU EQ SP", fontsize=8, va="bottom")
    ax.text(hx + 21, hy + 15.5, "ON PCD Ø110", fontsize=8, va="bottom")
    # Side view (section through the centre) to the right.
    sx = 205
    ax.text(sx + T + 4, cy + D / 2 - 6, "SIDE VIEW", fontsize=7.5)
    ax.add_patch(Rectangle((sx, cy - D / 2), T, D, fill=False, **LINE))
    for edge in (-bore_d / 2, bore_d / 2):
        ax.plot([sx, sx + T], [cy + edge] * 2, **HIDDEN)
    for y in (pcd / 2, -pcd / 2):
        for edge in (-hole_d / 2, hole_d / 2):
            ax.plot([sx, sx + T], [cy + y + edge] * 2, **HIDDEN)
    ax.plot([sx - 4, sx + T + 4], [cy, cy], **CENTRE)
    hdim(ax, sx, sx + T, cy + D / 2 + 3.5, "16", ext_from=cy + D / 2, text_dy=1.2)
    notes = ["NOTES:", "1. Holes equally spaced,", "    first hole on +X axis.", "2. All holes through.", "3. Do not scale; use", "    printed dimensions only."]
    for i, line in enumerate(notes):
        ax.text(232, 100 - i * 6.5, line, fontsize=7 if i else 7.5, weight="bold" if not i else "normal")
    return fig


def coupling(code: str, title: str):
    """Bolted double-flange coupling: 4 part definitions, 15 instances, explicit disassembly order."""
    fig, ax = sheet(code, title, "see parts list", "1:1 (DETAILS 1:2)")
    D, T, bore, pcd, hole = 100, 12, 40, 76, 11
    G, stud_d, stud_l, nut_d, nut_h = 2, 10, 46, 17, 8
    # SECTION A-A through the X axis (two of the four studs lie in the section plane).
    cx, z0 = 84, 118  # x of the assembly axis, y of the flange A bottom face
    ax.text(cx - D / 2, z0 + 66, "SECTION A-A  (ASSEMBLY, 1:1)", fontsize=7.5)
    hatch = dict(fill=False, hatch="////", linewidth=0.6, edgecolor="black")
    def plate(z, thick, label=None):
        for x1, x2 in ((cx - D / 2, cx - pcd / 2 - hole / 2), (cx - pcd / 2 + hole / 2, cx - bore / 2),
                       (cx + bore / 2, cx + pcd / 2 - hole / 2), (cx + pcd / 2 + hole / 2, cx + D / 2)):
            ax.add_patch(Rectangle((x1, z0 + z), x2 - x1, thick, **hatch))
    plate(0, T)
    plate(T, G)
    plate(T + G, T)
    for sx in (-1, 1):
        x = cx + sx * pcd / 2
        ax.add_patch(Rectangle((x - stud_d / 2, z0 - 10), stud_d, stud_l, fill=False, **LINE))
        for zn in (-nut_h, 2 * T + G):
            ax.add_patch(Rectangle((x - nut_d / 2, z0 + zn), (nut_d - stud_d) / 2, nut_h, fill=False, **LINE))
            ax.add_patch(Rectangle((x + stud_d / 2, z0 + zn), (nut_d - stud_d) / 2, nut_h, fill=False, **LINE))
        ax.plot([x, x], [z0 - 13, z0 + stud_l - 7], **CENTRE)
    ax.plot([cx, cx], [z0 - 6, z0 + 2 * T + G + 6], **CENTRE)
    # Assembly datum: Z = 0 on the bottom face of flange A.
    ax.plot([cx - D / 2 - 4, cx - D / 2 + 30], [z0, z0], color="black", linewidth=0.5)
    ax.fill([cx - 18, cx - 15.5, cx - 13], [z0 - 4.5, z0, z0 - 4.5], color="black", linewidth=0)
    ax.text(cx - 12, z0 - 4.6, "Z = 0 (DATUM)", fontsize=6.5, va="bottom")
    # Stack dimensions on the right.
    right = cx + D / 2
    vdim(ax, z0, z0 + T, right + 10, "12", ext_from=right)
    ax.text(right + 13, z0 + T + 1, "2", fontsize=8, va="center")
    ax.plot([right + 1, right + 12], [z0 + T + G / 2, z0 + T + G / 2], **THIN)
    vdim(ax, z0 + T + G, z0 + 2 * T + G, right + 10, "12", ext_from=right)
    vdim(ax, z0, z0 + 2 * T + G, right + 22, "26", ext_from=right + 10)
    left_stud = cx - pcd / 2
    vdim(ax, z0 - 10, z0 + 36, cx - D / 2 - 14, "46", ext_from=left_stud - stud_d / 2)
    vdim(ax, z0 + 2 * T + G, z0 + 2 * T + G + nut_h, cx - D / 2 - 5, "8", ext_from=left_stud - nut_d / 2)
    hdim(ax, cx - bore / 2, cx + bore / 2, z0 - 15, "Ø40", ext_from=z0)
    hdim(ax, cx - pcd / 2, cx + pcd / 2, z0 - 24, "PCD Ø76", ext_from=z0 - 10, text_dy=1.0)
    hdim(ax, cx - D / 2, cx + D / 2, z0 - 33, "Ø100", ext_from=z0)
    # Item balloons.
    def balloon(n, tip, at):
        ax.plot([tip[0], at[0]], [tip[1], at[1]], **THIN)
        ax.add_patch(Circle(at, 3.2, fill=False, **THIN))
        ax.text(at[0], at[1], str(n), fontsize=7.5, ha="center", va="center")
    balloon(1, (cx - 26, z0 + T + G + 8), (cx - 26, z0 + 52))
    balloon(2, (cx - 30, z0 + T + 1), (cx - 12, z0 + 52))
    balloon(1, (cx + 26, z0 + 4), (cx + 4, z0 + 52))
    balloon(3, (cx + pcd / 2, z0 + 35), (cx + 26, z0 + 52))
    balloon(4, (cx + pcd / 2 + 7, z0 + 2 * T + G + 5), (cx + 48, z0 + 52))
    # DETAIL: item 1 / item 2 top view at 1:2.
    dx, dy, k = 205, 118, 0.5
    ax.text(dx - 26, dy + 33, "ITEM 1 FLANGE - TOP VIEW (1:2)", fontsize=7)
    ax.add_patch(Circle((dx, dy), D / 2 * k, fill=False, **LINE))
    ax.add_patch(Circle((dx, dy), bore / 2 * k, fill=False, **LINE))
    ax.add_patch(Circle((dx, dy), pcd / 2 * k, fill=False, **CENTRE))
    for i in range(4):
        a = math.radians(90 * i)
        ax.add_patch(Circle((dx + pcd / 2 * k * math.cos(a), dy + pcd / 2 * k * math.sin(a)), hole / 2 * k, fill=False, **LINE))
    ax.plot([dx - 30, dx + 30], [dy, dy], **CENTRE)
    ax.plot([dx, dx], [dy - 30, dy + 30], **CENTRE)
    ax.text(dx - 29, dy - 1.5, "A", fontsize=7, va="top")
    ax.text(dx + 27, dy - 1.5, "A", fontsize=7, va="top")
    callouts = ["Ø100 x 12", "Ø40 THRU", "4 x Ø11 THRU EQ SP", "ON PCD Ø76,", "FIRST HOLE ON +X", "ITEM 2 GASKET: SAME", "OUTLINE AND HOLES, T = 2"]
    for i, line in enumerate(callouts):
        ax.text(dx + 30, dy + 22 - i * 5.2, line, fontsize=6.5)
    # DETAIL: items 3 and 4 at 1:2.
    sx0, sy0 = 205, 66
    ax.text(sx0 - 26, sy0 + 11, "ITEM 3 STUD / ITEM 4 NUT (1:2)", fontsize=7)
    ax.add_patch(Rectangle((sx0 - 22, sy0 - stud_d * k / 2), stud_l * k, stud_d * k, fill=False, **LINE))
    ax.text(sx0 - 22, sy0 + 5, "Ø10 x 46", fontsize=6.5)
    ax.add_patch(Rectangle((sx0 + 14, sy0 - nut_d * k / 2), nut_h * k, nut_d * k, fill=False, **LINE))
    for edge in (-stud_d * k / 2, stud_d * k / 2):
        ax.plot([sx0 + 14, sx0 + 14 + nut_h * k], [sy0 + edge] * 2, **HIDDEN)
    ax.text(sx0 + 21, sy0 + 2, "Ø17 x 8,", fontsize=6.5)
    ax.text(sx0 + 21, sy0 - 3.5, "Ø10 THRU", fontsize=6.5)
    # Parts list.
    bx, by, rows = 175, 160, [("ITEM", "NAME", "QTY", "SPEC", "MATERIAL"),
                              ("1", "FLANGE", "2", "Ø100 x 12, Ø40 BORE, 4 x Ø11 ON PCD Ø76", "Q235"),
                              ("2", "GASKET", "1", "Ø100 x 2, BORE AND HOLES AS ITEM 1", "NBR"),
                              ("3", "STUD M10", "4", "Ø10 x 46", "8.8"),
                              ("4", "NUT M10", "8", "Ø17 x 8, Ø10 THRU (SIMPLIFIED)", "8")]
    cols = (0, 8, 25, 33, 98, 112)
    for r, row in enumerate(rows):
        y = by + (len(rows) - r) * 6.5
        ax.plot([bx, bx + cols[-1]], [y, y], **THIN)
        for c, value in enumerate(row):
            ax.text(bx + cols[c] + 1.0, y - 3.25, value, fontsize=5.6, va="center", weight="bold" if r == 0 else "normal")
    ax.plot([bx, bx + cols[-1]], [by, by], **THIN)
    for c in cols:
        ax.plot([bx + c, bx + c], [by, by + len(rows) * 6.5], **THIN)
    ax.text(bx, by + len(rows) * 6.5 + 2.5, "PARTS LIST", fontsize=7.5, weight="bold")
    notes = ["NOTES:",
             "1. Datum Z = 0 is the bottom face of flange A. Stack (Z, mm):",
             "    lower nuts -8...0 | flange A 0...12 | gasket 12...14 |",
             "    flange B 14...26 | upper nuts 26...34 | studs -10...36.",
             "2. Studs on PCD Ø76 at 0/90/180/270 deg, first stud on +X;",
             "    each stud protrudes 2 mm beyond its nuts.",
             "3. Disassembly order: upper nuts (+Z), flange B (+Z),",
             "    gasket (+Z), lower nuts (-Z); flange A keeps the studs.",
             "4. Do not scale; use printed dimensions only."]
    for i, line in enumerate(notes):
        ax.text(16, 66 - i * 5.8, line, fontsize=7 if i else 7.5, weight="bold" if not i else "normal")
    return fig


def save(fig, name):
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f"{name}.pdf")
    fig.savefig(OUT / f"{name}.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    save(plate("EA-D01", "MOUNTING BASE PLATE", "12"), "EA-D01-mounting-plate")
    save(flange("EA-D02", "BOLTED FLANGE"), "EA-D02-flange")
    save(plate("EA-D03", "MOUNTING BASE PLATE", None), "EA-D03-missing-thickness")
    save(coupling("EA-D04", "FLANGE COUPLING ASSEMBLY"), "EA-D04-flange-coupling")
    print(sorted(p.name for p in OUT.iterdir()))
