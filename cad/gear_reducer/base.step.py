import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build123d import *

from cadgen import srgb
from common import *


def _boss_lower(radius, center_y):
    """Lower half (Z <= 0) of a bearing-boss cylinder whose axis runs along X."""
    length = BODY_LENGTH + 2 * BOSS_STICKOUT
    full = Cylinder(radius, length, rotation=(0, 90, 0))
    full = full.moved(Location((0, center_y, 0)))
    clip = Box(
        length + 4,
        2 * radius + 4,
        2 * radius + 4,
        align=(Align.CENTER, Align.CENTER, Align.MAX),
    )
    clip = clip.moved(Location((0, center_y, 0)))
    return full & clip


def _rib(sx, yc, r):
    """Triangular reinforcement rib at the front/rear wall below a bearing boss."""
    plane = Plane.YZ.offset(sx * BODY_LENGTH / 2)
    pts = [
        (yc, -r),
        (yc - RIB_W, -BOTTOM_HEIGHT + 60.0),
        (yc + RIB_W, -BOTTOM_HEIGHT + 60.0),
    ]
    with BuildPart() as rib_part:
        with BuildSketch(plane):
            with Locations((0, 0)):
                Polygon(*pts)
        extrude(amount=sx * RIB_T)
    return rib_part.part


def gen_step():
    # --- main shell + parting flange ----------------------------------------
    body = Box(
        BODY_LENGTH, BODY_WIDTH, BOTTOM_HEIGHT,
        align=(Align.CENTER, Align.CENTER, Align.MAX),
    )
    flange = Box(
        BODY_LENGTH + 2 * FLANGE_W, BODY_WIDTH + 2 * FLANGE_W, FLANGE_T,
        align=(Align.CENTER, Align.CENTER, Align.MAX),
    )
    base = body + flange

    # --- bearing bosses (lower halves) --------------------------------------
    base = base + _boss_lower(HS_BOSS_DIA / 2, HS_Y)
    base = base + _boss_lower(LS_BOSS_DIA / 2, LS_Y)

    # --- hollow interior -----------------------------------------------------
    cavity = Box(
        BODY_LENGTH - 2 * WALL_T, BODY_WIDTH - 2 * WALL_T, BOTTOM_HEIGHT - WALL_T,
        align=(Align.CENTER, Align.CENTER, Align.MAX),
    )
    base = base - cavity

    # --- coaxial bearing bores (full cylinders, single setup) ----------------
    bore_len = BODY_LENGTH + 2 * BOSS_STICKOUT + 4
    hs_bore = Cylinder(HS_BORE_DIA / 2, bore_len, rotation=(0, 90, 0))
    hs_bore = hs_bore.moved(Location((0, HS_Y, 0)))
    ls_bore = Cylinder(LS_BORE_DIA / 2, bore_len, rotation=(0, 90, 0))
    ls_bore = ls_bore.moved(Location((0, LS_Y, 0)))
    base = base - [hs_bore, ls_bore]

    # --- mounting feet -------------------------------------------------------
    feet = []
    foot_holes = []
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            fx = sx * (BODY_LENGTH / 2 - FOOT_W / 2)
            fy = sy * (BODY_WIDTH / 2 + FOOT_W / 2)
            fz = -BOTTOM_HEIGHT - FOOT_H / 2
            feet.append(Box(FOOT_W, FOOT_W, FOOT_H).moved(Location((fx, fy, fz))))
            foot_holes.append(
                Cylinder(FOOT_BOLT / 2, FOOT_H + 4).moved(Location((fx, fy, fz)))
            )
    base = base + feet
    base = base - foot_holes

    # --- reinforcement ribs --------------------------------------------------
    for sx in (-1.0, 1.0):
        base = base + _rib(sx, HS_Y, HS_BOSS_DIA / 2)
        base = base + _rib(sx, LS_Y, LS_BOSS_DIA / 2)

    # --- split-face bolt holes ----------------------------------------------
    bolt_x = [-190.0, -95.0, 0.0, 95.0, 190.0]
    bolt_positions = []
    for y_sign in (-1.0, 1.0):
        for bx in bolt_x:
            bolt_positions.append((bx, y_sign * (BODY_WIDTH / 2 + FLANGE_W / 2)))
    # end flanges (between the bearing bosses)
    for x_sign in (-1.0, 1.0):
        bolt_positions.append((x_sign * (BODY_LENGTH / 2 + FLANGE_W / 2), 0.0))

    bolt_holes = []
    for bx, by in bolt_positions:
        bolt_holes.append(
            Cylinder(BOLT_HOLE / 2, FLANGE_T + 4).moved(
                Location((bx, by, -FLANGE_T / 2))
            )
        )
    base = base - bolt_holes

    # --- dowel pin holes (diagonal pair) -------------------------------------
    dowel_holes = []
    for bx, by in ((-160.0, BODY_WIDTH / 2 + FLANGE_W / 2),
                   (160.0, -(BODY_WIDTH / 2 + FLANGE_W / 2))):
        dowel_holes.append(
            Cylinder(DOWEL_DIA / 2, FLANGE_T + 4).moved(Location((bx, by, -FLANGE_T / 2)))
        )
    base = base - dowel_holes

    # --- oil gauge tap (side wall, at oil level) -----------------------------
    gauge = Cylinder(OIL_GAUGE_DIA / 2, WALL_T + 4, rotation=(90, 0, 0))
    gauge = gauge.moved(Location((0, -BODY_WIDTH / 2, -OIL_POOL_DEPTH * 0.6)))
    base = base - gauge

    # --- drain tap (sump bottom, side wall) ----------------------------------
    drain = Cylinder(DRAIN_DIA / 2, WALL_T + 4, rotation=(90, 0, 0))
    drain = drain.moved(Location((0, -BODY_WIDTH / 2, -BOTTOM_HEIGHT + 30.0)))
    base = base - drain

    base.label = "base"
    base.color = srgb("#5B6673")
    return base
