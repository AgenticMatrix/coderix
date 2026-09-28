"""火箭级间爆炸分离螺栓 (stage-separation explosive bolt), M20.

工作原理: 螺栓螺纹端旋入下面级接头, 六角头压紧上面级接头; 电点火器
起爆后, 火药腔内燃气压力作用于减弱切槽断面, 螺栓在分离面瞬时断裂,
两级解除连接. 头部支承面 O 形圈与点火器座孔 O 形圈实现防潮密封.

坐标系: Z 轴 = 螺栓轴线; 原点位于减弱切槽中面 (= 级间分离面);
+Z 指向六角头部 (上面级侧), -Z 指向螺纹端 (旋入下面级).

螺纹按工业 STEP 交换惯例做装饰处理 (圆柱面, 螺纹参数见标注):
- 外螺纹 M20x2.5-6g: 按 Ø20 大径圆柱建模
- 点火器接口内螺纹 M10x1-6H: 按 Ø9.0 小径孔建模
材料 (仅文档标注): 30CrMnSiA 高强钢.

工程量:
- 断裂环带面积 ≈ 56.5 mm^2 (槽底 Ø13.5, 腔 Ø10.5, 壁厚 1.5 mm/侧)
- 火药腔容积 ≈ 1.65 cm^3
- 总长 74.5 mm; 包围盒 39.26 x 34.0 x 74.5 mm
"""

from math import cos, hypot, pi, radians, sin, sqrt, tan

from build123d import Axis, BuildPart, Face, GeomType, Line, Location, Mode, ThreePointArc, Wire, add, chamfer, extrude, fillet, revolve

from cadgen import srgb
from cadgen.assembly import label_shape

# --- 螺纹端 (下端, 旋入下面级接头) -----------------------------------------
THREAD_END_Z = -42.0          # 螺纹端面
END_CHAMFER = 2.5             # 端部 45° 倒角 (径向深度)
THREAD_TOP_Z = -10.0          # 螺纹段上端 (退刀槽起点)
RELIEF_DIA = 17.3             # 螺纹退刀槽直径 (M20x2.5)
RELIEF_WIDTH = 3.0            # 退刀槽宽
RELIEF_ROOT_R = 0.5           # 退刀槽根部圆角

# --- 杆身与减弱切槽 (分离面 z=0) ---------------------------------------------
SHANK_DIA = 20.0
GROOVE_WIDTH = 3.2            # 减弱槽全宽 (z = ±1.6)
GROOVE_ROOT_DIA = 13.5        # 槽底直径
GROOVE_ROOT_R = 0.3           # 槽底圆角 (控制应力集中)
CHAMBER_DIA = 10.5            # 火药腔直径 (槽底壁厚 1.5 mm/侧)

# --- 六角头部 ----------------------------------------------------------------
HEAD_AF = 34.0                # 对边宽度 (加大规格, 为端面密封槽留壁厚)
HEAD_BOTTOM_Z = 20.0          # 头部支承面 (端面密封圈所在面)
HEAD_HEIGHT = 12.5
HEAD_TOP_Z = HEAD_BOTTOM_Z + HEAD_HEIGHT
HEAD_TOP_CHAMFER = 1.5        # 顶面周边 45° 倒角
HEAD_ROOT_R = 0.6             # 头下圆角

# --- 头部支承面 O 形圈槽 (对上面级接头端面防潮) ------------------------------
FACE_SEAL_CL_DIA = 26.0       # 槽中径
FACE_SEAL_WIDTH = 2.7         # 槽宽 (适配 ~Ø26x2 O 形圈)
FACE_SEAL_DEPTH = 1.45        # 槽深

# --- 点火器接口 (头顶面中心, M10x1 电点火器) ---------------------------------
PORT_BORE_DIA = 9.0           # M10x1-6H 小径孔 (装饰螺纹)
PORT_THREAD_DEPTH = 9.0       # 螺纹孔深度
PORT_MOUTH_CHAMFER = 0.5      # 孔口 45° 倒角
SEAL_BORE_DIA = 8.0           # 点火器密封座孔 H9
SEAL_BORE_DEPTH = 6.5         # 座孔长度
PORT_RING_GROOVE_DIA = 10.2   # 座孔内径向 O 形圈槽 (适配 ~Ø8x1.5 O 形圈)
PORT_RING_GROOVE_WIDTH = 2.2
ORIFICE_DIA = 4.0             # 传火孔
ORIFICE_LEN = 3.0

# --- 火药腔 ------------------------------------------------------------------
CHAMBER_TOP_Z = 14.0          # 腔顶 (传火孔下口)
CHAMBER_BOTTOM_Z = -4.0       # 腔圆柱段底, 越过分离面使压力作用于槽断面
DRILL_POINT_ANGLE = 118.0     # 钻尖角

# --- 派生尺寸 ----------------------------------------------------------------
PORT_THREAD_BOTTOM_Z = HEAD_TOP_Z - PORT_THREAD_DEPTH                          # 23.5
SEAL_BORE_BOTTOM_Z = PORT_THREAD_BOTTOM_Z - SEAL_BORE_DEPTH                    # 17.0
ORIFICE_BOTTOM_Z = SEAL_BORE_BOTTOM_Z - ORIFICE_LEN                             # 14.0
PORT_RING_GROOVE_TOP_Z = SEAL_BORE_BOTTOM_Z + (SEAL_BORE_DEPTH + PORT_RING_GROOVE_WIDTH) / 2  # 21.35
PORT_RING_GROOVE_BOTTOM_Z = PORT_RING_GROOVE_TOP_Z - PORT_RING_GROOVE_WIDTH    # 19.15
FACE_GROOVE_FLOOR_Z = HEAD_BOTTOM_Z + FACE_SEAL_DEPTH                           # 21.45
FACE_GROOVE_R_IN = FACE_SEAL_CL_DIA / 2 - FACE_SEAL_WIDTH / 2                   # 11.65
FACE_GROOVE_R_OUT = FACE_SEAL_CL_DIA / 2 + FACE_SEAL_WIDTH / 2                  # 14.35
CONE_APEX_Z = CHAMBER_BOTTOM_Z - (CHAMBER_DIA / 2) / tan(radians(DRILL_POINT_ANGLE / 2))  # ≈ -7.154

FRACTURE_AREA_MM2 = pi / 4 * (GROOVE_ROOT_DIA ** 2 - CHAMBER_DIA ** 2)          # ≈ 56.5


def _corner_arc(prev_pt, corner, next_pt, radius):
    """直角折线 prev->corner->next 的圆角: 返回 (切点1, 弧中点, 切点2).
    仅支持正交 (90°) 轴对齐角点."""
    u1 = (corner[0] - prev_pt[0], corner[1] - prev_pt[1])
    u2 = (next_pt[0] - corner[0], next_pt[1] - corner[1])
    l1, l2 = hypot(*u1), hypot(*u2)
    u1 = (u1[0] / l1, u1[1] / l1)
    u2 = (u2[0] / l2, u2[1] / l2)
    if abs(u1[0] * u2[0] + u1[1] * u2[1]) > 1e-9:
        raise ValueError("圆角顶点不是直角")
    if radius > min(l1, l2) / 2:
        raise ValueError("圆角半径大于相邻线段的一半")
    t1 = (corner[0] - radius * u1[0], corner[1] - radius * u1[1])
    t2 = (corner[0] + radius * u2[0], corner[1] + radius * u2[1])
    center = (corner[0] - radius * u1[0] + radius * u2[0],
              corner[1] - radius * u1[1] + radius * u2[1])
    v1 = (t1[0] - center[0], t1[1] - center[1])
    v2 = (t2[0] - center[0], t2[1] - center[1])
    bis = (v1[0] + v2[0], v1[1] + v2[1])
    bl = hypot(*bis)
    mid = (center[0] + radius * bis[0] / bl, center[1] + radius * bis[1] / bl)
    return t1, mid, t2


def _profile_wire(points, fillets=None):
    """XZ 平面 (y=0) 上的闭合轮廓 Wire; points 为 (r, z) 顶点,
    fillets 为 {顶点下标: 圆角半径}."""
    fillets = fillets or {}
    n = len(points)
    arcs = {i: _corner_arc(points[i - 1], points[i],
                           points[(i + 1) % n], r)
            for i, r in fillets.items()}
    edges = []
    for i in range(n):
        j = (i + 1) % n
        start = arcs[i][2] if i in arcs else points[i]
        end = arcs[j][0] if j in arcs else points[j]
        edges.append(Line((start[0], 0.0, start[1]), (end[0], 0.0, end[1])))
        if j in arcs:
            t1, mid, t2 = arcs[j]
            edges.append(ThreePointArc((t1[0], 0.0, t1[1]),
                                        (mid[0], 0.0, mid[1]),
                                        (t2[0], 0.0, t2[1])))
    return Wire(edges)


def _revolve_profile(points, fillets=None):
    """回转体: XZ 平面轮廓绕 Z 轴旋转 360°."""
    face = Face(_profile_wire(points, fillets))
    solid = revolve(face, axis=Axis.Z)
    if solid.volume <= 0:
        raise ValueError("旋转体体积为负, 轮廓绕向错误")
    return solid


def _make_outer_body():
    """杆身 + 减弱槽 + 退刀槽 + 端部倒角 (回转体, 顶部埋入头部)."""
    r_shank = SHANK_DIA / 2
    r_root = GROOVE_ROOT_DIA / 2
    r_relief = RELIEF_DIA / 2
    hw = GROOVE_WIDTH / 2
    points = [
        (0.0, THREAD_END_Z),                       # 轴线, 螺纹端面
        (0.0, HEAD_BOTTOM_Z + 1.0),                # 轴线, 杆顶 (埋入头部)
        (r_shank, HEAD_BOTTOM_Z + 1.0),
        (r_shank, hw),                             # 减弱槽上肩
        (r_root, hw),                              # 槽根角 (R0.3)
        (r_root, -hw),                             # 槽根角 (R0.3)
        (r_shank, -hw),                            # 减弱槽下肩
        (r_shank, THREAD_TOP_Z + RELIEF_WIDTH),    # 退刀槽上角 (R0.5)
        (r_relief, THREAD_TOP_Z + RELIEF_WIDTH),
        (r_relief, THREAD_TOP_Z),                  # 退刀槽下角 (R0.5)
        (r_shank, THREAD_TOP_Z),
        (r_shank, THREAD_END_Z + END_CHAMFER),     # 螺纹段
        (r_shank - END_CHAMFER, THREAD_END_Z),     # 45° 端部倒角
    ]
    return _revolve_profile(points, fillets={4: GROOVE_ROOT_R, 5: GROOVE_ROOT_R,
                                             7: RELIEF_ROOT_R, 9: RELIEF_ROOT_R})


def _make_hex_head():
    """六角头棱柱, z = HEAD_BOTTOM_Z .. HEAD_TOP_Z (对边 34)."""
    circum = HEAD_AF / sqrt(3.0)
    pts = [(circum * cos(radians(a)), circum * sin(radians(a)))
           for a in range(0, 360, 60)]
    face = Face(Wire([Line(pts[i], pts[(i + 1) % 6]) for i in range(6)]))
    head = extrude(face, HEAD_HEIGHT)
    return head.moved(Location((0, 0, HEAD_BOTTOM_Z)))


def _make_cavity():
    """点火接口 + 密封座孔 + 传火孔 + 火药腔, 单一回转切除工具."""
    overshoot = HEAD_TOP_Z + 2.5
    points = [
        (0.0, CONE_APEX_Z),                        # 钻尖顶点 (轴线)
        (0.0, overshoot),                          # 轴线, 越过头顶面
        (PORT_BORE_DIA / 2 + PORT_MOUTH_CHAMFER, overshoot),
        (PORT_BORE_DIA / 2 + PORT_MOUTH_CHAMFER, HEAD_TOP_Z),
        (PORT_BORE_DIA / 2, HEAD_TOP_Z - PORT_MOUTH_CHAMFER),   # 孔口倒角
        (PORT_BORE_DIA / 2, PORT_THREAD_BOTTOM_Z),  # M10x1 螺纹孔
        (SEAL_BORE_DIA / 2, PORT_THREAD_BOTTOM_Z),  # 密封座孔 Ø8
        (SEAL_BORE_DIA / 2, PORT_RING_GROOVE_TOP_Z),
        (PORT_RING_GROOVE_DIA / 2, PORT_RING_GROOVE_TOP_Z),     # O 形圈槽
        (PORT_RING_GROOVE_DIA / 2, PORT_RING_GROOVE_BOTTOM_Z),
        (SEAL_BORE_DIA / 2, PORT_RING_GROOVE_BOTTOM_Z),
        (SEAL_BORE_DIA / 2, SEAL_BORE_BOTTOM_Z),
        (ORIFICE_DIA / 2, SEAL_BORE_BOTTOM_Z),      # 传火孔 Ø4
        (ORIFICE_DIA / 2, CHAMBER_TOP_Z),
        (CHAMBER_DIA / 2, CHAMBER_TOP_Z),           # 火药腔 Ø10.5
        (CHAMBER_DIA / 2, CHAMBER_BOTTOM_Z),
    ]
    return _revolve_profile(points)


def _make_face_groove_ring():
    """头部支承面 O 形圈槽切除工具 (环形, 越程到支承面下方)."""
    points = [
        (FACE_GROOVE_R_IN, HEAD_BOTTOM_Z - 1.5),
        (FACE_GROOVE_R_IN, FACE_GROOVE_FLOOR_Z),
        (FACE_GROOVE_R_OUT, FACE_GROOVE_FLOOR_Z),
        (FACE_GROOVE_R_OUT, HEAD_BOTTOM_Z - 1.5),
    ]
    return _revolve_profile(points)


def _circle_edges(part, radius, z, tol=1e-3):
    """选半径/高度匹配的整圆边 (倒角/圆角用)."""
    return [e for e in part.edges()
            if e.geom_type == GeomType.CIRCLE
            and abs(e.radius - radius) < tol
            and abs(e.center().Z - z) < tol]


def gen_step():
    # algebra 模式构建各特征实体, 提取 Solid 后在 BuildPart 内做布尔运算
    # (Part + Part 只分组不融合, 必须用 BuildPart.add(Solid) 做布尔融合)
    body = _make_outer_body().solids()[0]
    hex_solid = _make_hex_head().solids()[0]
    cavity = _make_cavity().solids()[0]
    ring = _make_face_groove_ring().solids()[0]

    with BuildPart() as part:
        add(body)
        add(hex_solid)
        add(cavity, mode=Mode.SUBTRACT)
        add(ring, mode=Mode.SUBTRACT)

    solid = part.part

    head_root = _circle_edges(solid, SHANK_DIA / 2, HEAD_BOTTOM_Z)
    if len(head_root) != 1:
        raise ValueError(f"头下圆角边选择异常: {len(head_root)} 条")
    solid = fillet(head_root, HEAD_ROOT_R)

    top_edges = [e for e in solid.edges()
                 if e.geom_type == GeomType.LINE
                 and abs(e.center().Z - HEAD_TOP_Z) < 1e-3]
    if len(top_edges) != 6:
        raise ValueError(f"六角顶边选择异常: {len(top_edges)} 条")
    solid = chamfer(top_edges, HEAD_TOP_CHAMFER)

    if len(solid.solids()) != 1 or solid.volume <= 0:
        raise ValueError("实体检查失败: 非单一实体或体积为负")

    label_shape(solid, "explosive_bolt_m20", color=srgb("#49525E"))
    return solid
