import importlib.util
import sys

from build123d import *

spec = importlib.util.spec_from_file_location("base_gen", "base.step.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
solid = mod.gen_step()

lines = []

for i, face in enumerate(solid.faces()):
    if getattr(face, "geom_type", None) != GeomType.CYLINDER:
        continue
    r = getattr(face, "radius", None)
    radii = []
    centers = []
    for e in face.edges():
        try:
            er = e.radius
            radii.append(round(er, 3))
            c = e.center()
            centers.append((round(c.X, 1), round(c.Y, 1), round(c.Z, 1)))
        except Exception:
            pass
    if r is not None:
        lines.append(f"f{i}: full_radius={r}")
    elif radii:
        uniq = sorted(set(radii))
        lines.append(f"f{i}: PARTIAL edge_radii={uniq} centers={centers}")
    else:
        lines.append(f"f{i}: radius=None (no circular edges)")

with open("_analyze.log", "w") as f:
    f.write("\n".join(lines))
