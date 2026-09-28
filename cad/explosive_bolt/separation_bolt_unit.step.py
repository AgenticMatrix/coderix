"""级间分离螺栓单元装配体: 爆炸螺栓 + 电点火器(包络) + 2 处 O 形密封圈.

坐标约定与 explosive_bolt.step.py 一致 (原点 = 分离面中心, +Z 头部).
装配为"待发"状态: 点火器旋入到位 (法兰支承于头顶面), O 形圈处于安装槽内.

点火器为接口尺寸真实的简化包络体 (螺纹段/密封座/法兰/插座);
O 形圈按槽配合尺寸建模 (安装态, 略有压缩).
"""

import importlib.util
from pathlib import Path

from build123d import Cylinder, Location, Torus

from cadgen import srgb
from cadgen.assembly import AssemblyHelper


def _load_entry(step_py_path):
    path = Path(step_py_path)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_bolt = _load_entry(Path(__file__).parent / "explosive_bolt.step.py")

# O 形圈安装位置 (来自螺栓几何参数)
PORT_RING_Z = (_bolt.PORT_RING_GROOVE_TOP_Z + _bolt.PORT_RING_GROOVE_BOTTOM_Z) / 2  # 20.25
FACE_RING_Z = (_bolt.HEAD_BOTTOM_Z + _bolt.FACE_GROOVE_FLOOR_Z) / 2                 # 20.725


def _make_initiator():
    """电点火器简化包络 (局部坐标: 法兰支承面 z=0, 向上为插座).
    接口尺寸真实: M10x1 螺纹段 / Ø7.8 密封座 / Ø13 法兰 / Ø6 插座."""
    flange = Cylinder(6.5, 3.0).moved(Location((0, 0, 1.5)))          # Ø13x3 法兰, z 0..3
    body = Cylinder(4.9, 9.5).moved(Location((0, 0, -4.25)))          # M10x1 螺纹段, z -9..0.5
    land = Cylinder(3.9, 6.5).moved(Location((0, 0, -11.75)))         # Ø7.8 密封座, z -15..-8.5
    connector = Cylinder(3.0, 7.5).moved(Location((0, 0, 6.25)))      # Ø6 插座, z 2.5..10
    return flange + body + land + connector


def gen_step():
    bolt = _bolt.gen_step()
    initiator = _make_initiator()
    oring_port = Torus(major_radius=4.5, minor_radius=0.6)    # 点火器座孔径向密封
    oring_face = Torus(major_radius=13.0, minor_radius=0.725)  # 头部端面密封

    asm = AssemblyHelper("separation_bolt_unit")
    bolt_child = asm.add(bolt, "explosive_bolt_m20", color=srgb("#49525E"))
    init_child = asm.add(initiator, "electric_initiator", color=srgb("#969DA6"))
    ring_port = asm.add(oring_port, "o_ring_port_seal", color=srgb("#23262B"))
    ring_face = asm.add(oring_face, "o_ring_face_seal", color=srgb("#23262B"))

    # 点火器: 法兰支承面贴合头顶面 (fixed=螺栓, moving=点火器)
    bolt_seat = asm.rigid_frame(bolt_child, "igniter_seat",
                                Location((0, 0, _bolt.HEAD_TOP_Z)))
    init_seat = asm.rigid_frame(init_child, "flange_bearing_face", Location((0, 0, 0)))
    asm.face_to_face(bolt_seat, init_seat, label="igniter_seated")

    # O 形圈: 同轴装入各自密封槽
    port_seat = asm.rigid_frame(bolt_child, "port_seal_seat", Location((0, 0, PORT_RING_Z)))
    port_c = asm.rigid_frame(ring_port, "ring_center", Location((0, 0, 0)))
    asm.coaxial(port_seat, port_c, label="port_o_ring_seated")

    face_seat = asm.rigid_frame(bolt_child, "face_seal_seat", Location((0, 0, FACE_RING_Z)))
    face_c = asm.rigid_frame(ring_face, "ring_center", Location((0, 0, 0)))
    asm.coaxial(face_seat, face_c, label="face_o_ring_seated")

    return asm.build()
