"""Shared parameters for the horizontal split gear reducer housing.

Units: millimeters.
Coordinate convention:
  - Parting plane (horizontal split face) at Z = 0.
  - +Z up (toward the lid).
  - Axial direction = X (shafts run along X).
  - Lateral direction = Y (the two shafts are separated by CENTER_DISTANCE along Y).

Manufacturing intent (recorded here; STEP geometry does not carry tolerances):
  - Material: HT200 grey cast iron.
  - Bearing bores: Ra 1.6 surface finish.
  - Bearing bore axes: parallelism 0.03 mm (single-setup coaxial boring).

The high-speed shaft centreline is at Y = -CENTER_DISTANCE / 2 and the
low-speed shaft centreline at Y = +CENTER_DISTANCE / 2; both lie on Z = 0.
"""

# --- Shafting / gears -------------------------------------------------------
CENTER_DISTANCE = 250.0      # centre distance a = (d1 + d2) / 2
HS_BORE_DIA = 90.0           # high-speed bearing bore
LS_BORE_DIA = 120.0          # low-speed bearing bore

# --- Overall envelope --------------------------------------------------------
BODY_LENGTH = 440.0          # axial length, front/rear wall outer faces
BODY_WIDTH = 340.0           # lateral width, side wall outer faces
TOP_HEIGHT = 200.0           # lid height (Z: 0 -> +TOP_HEIGHT)
BOTTOM_HEIGHT = 220.0        # base height (Z: 0 -> -BOTTOM_HEIGHT)
WALL_T = 16.0                # casting wall thickness

# --- Parting flange ----------------------------------------------------------
FLANGE_T = 26.0              # flange thickness (full flange height either side)
FLANGE_W = 42.0              # flange width measured outward from wall

# --- Bearing bosses ----------------------------------------------------------
HS_BOSS_DIA = 150.0          # high-speed bearing boss outer diameter
LS_BOSS_DIA = 180.0          # low-speed bearing boss outer diameter
BOSS_STICKOUT = 18.0         # boss axial protrusion beyond the wall face

# --- Fasteners ---------------------------------------------------------------
BOLT_NOM = 12.0              # M12 split-face bolts
BOLT_HOLE = 13.0             # M12 clearance hole
BOLT_HEAD_ACROSS = 18.0      # hex head across-flats
BOLT_HEAD_H = 8.0            # hex head height
BOLT_LENGTH = FLANGE_T * 2   # through both flanges
DOWEL_DIA = 10.0             # locating dowel pin diameter
DOWEL_LENGTH = FLANGE_T * 2  # dowel engagement length

# --- Oil system --------------------------------------------------------------
OIL_POOL_DEPTH = 60.0        # sump depth below the parting plane
OIL_GAUGE_DIA = 20.0         # oil level gauge tap (M20)
DRAIN_DIA = 16.0             # drain tap (M16)
VENT_DIA = 20.0              # breather tap (M20)

# --- Feet --------------------------------------------------------------------
FOOT_W = 70.0                # mounting foot width (along X)
FOOT_H = 32.0                # mounting foot height
FOOT_BOLT = 18.0             # foundation bolt hole diameter

# --- Reinforcement -----------------------------------------------------------
RIB_T = 12.0                 # rib thickness
RIB_W = 60.0                 # rib run-out width along the wall

# --- Derivation helpers ------------------------------------------------------
HS_Y = -CENTER_DISTANCE / 2.0
LS_Y = +CENTER_DISTANCE / 2.0
