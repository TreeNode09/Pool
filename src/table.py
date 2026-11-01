import time

import cv2 as cv
import numpy as np

import matplotlib.pyplot as plt

# 第一步：确定台呢颜色和粗四边形

SAMPLED_SHORT_SIDE = 220        # 下采样后的短边长度

GAUSSIAN_SIGMA_X = 0.2          # 高斯权重的标准差占图像高、宽的比例，峰值在图像中心
GAUSSIAN_SIGMA_Y = 0.2

SHADOW_THRESHOLD = 50           # 亮度过低或过高的像素不进入颜色直方图
HIGHLIGHT_THRESHOLD = 200

BINARY_THRESHOLD = 0.0001       # 直方图格子的权重至少占采样像素数的比例，才保留下来

REGION_SIZE_THRESHOLD = 0.01    # 一个颜色范围的权重和至少占采样像素数的比例

HUE_RADIUS = 4                  # 直方图闭运算沿色相、饱和度方向的半径
SATURATION_RADIUS = 8

HUE_BINS = 180                  # OpenCV 色相、饱和度取值范围
SATURATION_BINS = 256

POLY_EPSILON_RATIO = 0.02       # 多边形近似时，允许偏离轮廓的距离占周长的比例

FILL_RATIO_MIN = 0.6            # 色块像素数至少占凸包面积的比例，用来丢掉围住桌子的地板

CENTER_X_MIN = 0.15             # 质心必须落在图像的这个相对范围内，包含画面下方三分之一
CENTER_X_MAX = 0.85
CENTER_Y_MIN = 0.30
CENTER_Y_MAX = 0.90


# 第二步：收集粗边附近的霍夫线段

CANNY_THRESHOLD_LOW = 50        # cv.Canny 的阈值
CANNY_THRESHOLD_HIGH = 150

HOUGH_RHO = 1                   # 霍夫累加器的距离步长
HOUGH_THRESHOLD = 40            # 累加器阈值

HOUGH_MIN_LENGTH_RATIO = 0.12   # 最短线段占图像短边的比例
HOUGH_GAP_RATIO = 0.25          # 断裂允许占这条最短长度的比例

RAIL_PARALLEL = 0.93            # 线段方向和粗边的绝对余弦最小值（0.93 ≈ 22°）

RAIL_INWARD_RATIO = 0.022       # 线段中点相对粗边的法向偏移占短边的比例
RAIL_OUTWARD_RATIO = 0.11

ALONG_SPAN_RATIO = 1            # 线段中点沿边方向离开边中心的距离，最多占边长的比例


# 第三步：判断线段属于哪种边界

SIDE_DISTANCE_RATIOS = (0.011, 0.020, 0.028)    # 在线段两侧取样的距离，占图像短边的比例

SAMPLE_T_START = 0.2            # 沿线段取样的起点、终点和点数，避开两端的袋口
SAMPLE_T_END = 0.8
SAMPLE_COUNT = 8

CLOTH_HUE_TOLERANCE = 12        # 色相、饱和度相较台面的最大偏差
CLOTH_SATURATION_TOLERANCE = 50

CLOTH_LIGHTNESS_MAX = 230       # 台呢亮度最大值，用来避开高光

LABEL_FRACTION = 0.5            # 一侧至少这个比例的采样点符合，才把这一侧当成台呢或同色相

MIN_SIDE_POINTS = 2             # 一侧至少有这么多个点落在图像内，读数才有效

SHADOW_LIGHTNESS_GAP = 15       # 阴影要比另一侧至少暗这么多，并且不超过另一侧亮度的这个比例
SHADOW_LIGHTNESS_RATIO = 0.85

MIN_VOTES = 4                   # 一条线段至少要有这么多张有效票，并且得票最高的种类至少占这个比例
MIN_SUPPORT = 0.6


# 第四步：为每条边选择线段

CHOSEN_OFFSET_MIN_RATIO = -0.006    # 采用的线段可以略微进到粗边内侧，这个下限占短边的比例


# 第五步：相邻边求交得到四边形

CORNER_MOVE_RATIO = 0.25        # 新角点离开粗角点的距离最多占短边的比例

INTERSECT_EPS = 1e-8            # 两条直线几乎平行时，齐次坐标的第三项低于这个值就认为没有交点


def _median(values: list[int]) -> float:
    # 两三个数的中位数。偶数个时取中间两个的平均，和 np.median 一致
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2: return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2


def _unit(vector: np.ndarray) -> np.ndarray:
    # 向量归一化
    return vector / np.linalg.norm(vector)


def _line_through(start: np.ndarray, end: np.ndarray) -> np.ndarray:
    # 求过两点直线的齐次形式 ax + by + c = 0
    a = start[1] - end[1]
    b = end[0] - start[0]
    c = start[0] * end[1] - end[0] * start[1]

    return np.array([a, b, c], dtype=np.float64)


def _intersect(line_a: np.ndarray, line_b: np.ndarray) -> np.ndarray | None:
    # 求两条齐次直线的交点
    point = np.cross(line_a, line_b)

    if abs(point[2]) < INTERSECT_EPS: return None
    return (point[:2] / point[2]).astype(np.float32)


def order_quadrilateral(points: np.ndarray) -> np.ndarray:
    # 将角点绕质心按逆时针排列
    points = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])

    return points[np.argsort(angles)]


def GetCloth(image: np.ndarray) -> dict | None:
    """第一步：用加权色相-饱和度直方图找到台呢，并给出粗四边形"""

    def gaussian_mask(
        mask_rows: int, mask_cols: int, center_x: float, center_y: float,
        sigma_x: float, sigma_y: float) -> np.ndarray:
        # 生成高斯掩膜
        row, column = np.ogrid[0:mask_rows, 0:mask_cols]
        gaussian = np.exp(-((row - center_x) ** 2 / (2 * sigma_x**2) + (column - center_y) ** 2 / (2 * sigma_y**2)))

        return gaussian.astype(np.float32)


    def largest_component(region: np.ndarray) -> np.ndarray | None:
        # 找最大连通域。没有前景时不用再做轮廓
        count, labels, stats, _ = cv.connectedComponentsWithStats(region, connectivity=8)
        if count < 2: return None
        label = 1 + int(np.argmax(stats[1:, cv.CC_STAT_AREA]))

        return np.where(labels == label, np.uint8(255), np.uint8(0))

    def component_shape(component: np.ndarray) -> dict | None:
        # 凸包近似成多边形，用填充率区分台面和地板。不是四边形、填不满或质心不在桌面范围时立刻放弃
        contours, _ = cv.findContours(component, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
        if not contours: return None
        contour = max(contours, key=cv.contourArea)
        hull = cv.convexHull(contour)
        quadrilateral = cv.approxPolyDP(hull, POLY_EPSILON_RATIO * cv.arcLength(hull, True), True)
        if len(quadrilateral) != 4: return None

        hull_mask = np.zeros(component.shape, np.uint8)
        cv.drawContours(hull_mask, [hull], -1, 255, thickness=-1)
        hull_area = cv.countNonZero(hull_mask)
        area = cv.countNonZero(component)
        if hull_area == 0: return None
        fill_ratio = area / hull_area
        if fill_ratio < FILL_RATIO_MIN: return None

        moments = cv.moments(contour)
        if moments["m00"] == 0: return None
        center = (moments["m10"] / moments["m00"] * stride, moments["m01"] / moments["m00"] * stride)
        if not center_is_on_table(center, image_rows, image_cols): return None

        return {
            "component": component, "quadrilateral": quadrilateral * stride, "fill_ratio": fill_ratio,
            "center": center, "area": area
        }

    def center_is_on_table(center: tuple[float, float], image_rows: int, image_cols: int) -> bool:
        # 判断连通域中心是否在桌面上
        x, y = center

        return CENTER_X_MIN * image_cols <= x <= CENTER_X_MAX * image_cols\
            and CENTER_Y_MIN * image_rows <= y <= CENTER_Y_MAX * image_rows

    # 下采样，使短边大约为 SAMPLED_SHORT_SIDE，长边相应更大
    image_rows, image_cols = image.shape[:2]
    hls = cv.cvtColor(image, cv.COLOR_BGR2HLS)
    hue, lightness, saturation = cv.split(hls)

    stride = max(1, round(min(image_rows, image_cols) / SAMPLED_SHORT_SIDE))

    sampled_hue = hue[::stride, ::stride]
    sampled_saturation = saturation[::stride, ::stride]
    sampled_lightness = lightness[::stride, ::stride]
    sampled_rows, sampled_cols = sampled_hue.shape

    # 亮度落在阴影和高光之间的像素才进入直方图，并按离图像中心的距离加权
    weights = gaussian_mask(
        sampled_rows, sampled_cols, (image_rows / 2) / stride, (image_cols / 2) / stride,
        image_rows * GAUSSIAN_SIGMA_X / stride, image_cols * GAUSSIAN_SIGMA_Y / stride
    )
    weights *= (sampled_lightness > SHADOW_THRESHOLD) & (sampled_lightness < HIGHLIGHT_THRESHOLD)

    # 色相、饱和度本身就是整数格子。OpenCV 色相偶尔取到 180，放进最后一格
    hue_bin = np.minimum(sampled_hue.astype(np.int32), HUE_BINS - 1)
    saturation_bin = np.minimum(sampled_saturation.astype(np.int32), SATURATION_BINS - 1)
    hist = np.bincount(
        (hue_bin * SATURATION_BINS + saturation_bin).ravel(), weights=weights.ravel(), minlength=HUE_BINS * SATURATION_BINS
    ).reshape(HUE_BINS, SATURATION_BINS)

    # 去掉权重太小的格子，闭运算把相邻的色相、饱和度连成一块
    binary = (hist >= sampled_hue.size * BINARY_THRESHOLD).astype(np.uint8)
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2 * SATURATION_RADIUS + 1, 2 * HUE_RADIUS + 1))
    count, _, stats, _ = cv.connectedComponentsWithStats(cv.morphologyEx(binary, cv.MORPH_CLOSE, kernel), connectivity=8)

    # 权重不够的颜色范围先丢掉，再回到小图上取最大色块
    candidates = []
    region_min = sampled_hue.size * REGION_SIZE_THRESHOLD
    for label in range(1, count):

        saturation_min = int(stats[label, cv.CC_STAT_LEFT])
        hue_min = int(stats[label, cv.CC_STAT_TOP])
        saturation_max = saturation_min + int(stats[label, cv.CC_STAT_WIDTH]) - 1
        hue_max = hue_min + int(stats[label, cv.CC_STAT_HEIGHT]) - 1
        if hist[hue_min:hue_max + 1, saturation_min:saturation_max + 1].sum() < region_min: continue

        region = (
            (sampled_hue >= hue_min) & (sampled_hue <= hue_max)
            & (sampled_saturation >= saturation_min) & (sampled_saturation <= saturation_max)
        ).astype(np.uint8) * 255
        component = largest_component(region)
        if component is None: continue
        shape = component_shape(component)
        if shape is not None: candidates.append(shape)

    # 四边形、填充率、质心都已在 component_shape 里检查过，这里只留填充率最高的
    if not candidates: return None

    table = max(candidates, key=lambda shape: shape["fill_ratio"])
    cloth_pixels = table["component"] > 0
    table["hue_center"] = float(np.median(sampled_hue[cloth_pixels]))
    table["saturation_center"] = float(np.median(sampled_saturation[cloth_pixels]))
    table["quadrilateral"] = order_quadrilateral(table["quadrilateral"])

    return {
        "hls": hls, "hue": hue, "lightness": lightness, "saturation": saturation,
        "gray": cv.cvtColor(image, cv.COLOR_BGR2GRAY), "table": table, "rough": table["quadrilateral"]
    }


def GetSides(
    hue: np.ndarray, lightness: np.ndarray, saturation: np.ndarray, gray: np.ndarray, shape: dict
) -> list[dict]:
    """第二到第四步：收集粗边附近的霍夫线段，判断边界类型，再为每条边选一条。"""

    def matches_cloth(hue_value: int, saturation_value: int, lightness_value: int) -> bool:

        hue_distance = min(abs(hue_value - hue_center), HUE_BINS - abs(hue_value - hue_center))

        return hue_distance <= CLOTH_HUE_TOLERANCE\
            and abs(saturation_value - saturation_center) <= CLOTH_SATURATION_TOLERANCE\
            and lightness_value < CLOTH_LIGHTNESS_MAX

    def hue_close(hue_value: int) -> bool:

        return min(abs(hue_value - hue_center), HUE_BINS - abs(hue_value - hue_center)) <= CLOTH_HUE_TOLERANCE

    def side_reading(origin: np.ndarray, sign: float) -> tuple[float, float, float] | None:
        # 读线段一侧的亮度中位数、台呢比例和同色相比例
        levels, cloth, same_hue = [], [], []
        for distance in distances:

            point = np.rint(origin + outward * (sign * distance)).astype(int)
            x, y = int(point[0]), int(point[1])
            if not (0 <= x < cols and 0 <= y < rows): continue

            hue_value = int(hue[y, x])
            saturation_value = int(saturation[y, x])
            lightness_value = int(lightness[y, x])

            levels.append(lightness_value)
            cloth.append(matches_cloth(hue_value, saturation_value, lightness_value))
            same_hue.append(hue_close(hue_value))

        count = len(levels)
        if count < MIN_SIDE_POINTS: return None
        return _median(levels), sum(cloth) / count, sum(same_hue) / count

    def classify_segment(segment: np.ndarray) -> dict | None:
        # 沿线取样，按两侧的台呢和相对亮度投票
        votes = []
        for along in np.linspace(SAMPLE_T_START, SAMPLE_T_END, SAMPLE_COUNT):

            origin = segment[:2] * (1 - along) + segment[2:] * along
            inward = side_reading(origin, -1)
            outward_reading = side_reading(origin, 1)
            if inward is None or outward_reading is None: continue

            inward_level, inward_cloth, inward_hue = inward
            outward_level, outward_cloth, outward_hue = outward_reading

            inward_shadow = inward_hue >= LABEL_FRACTION\
                and inward_level + SHADOW_LIGHTNESS_GAP < outward_level\
                and inward_level <= SHADOW_LIGHTNESS_RATIO * outward_level
            outward_shadow = outward_hue >= LABEL_FRACTION\
                and outward_level + SHADOW_LIGHTNESS_GAP < inward_level\
                and outward_level <= SHADOW_LIGHTNESS_RATIO * inward_level

            inward_name = "shadow" if inward_shadow else ("cloth" if inward_cloth >= LABEL_FRACTION else "other")
            outward_name = "shadow" if outward_shadow else ("cloth" if outward_cloth >= LABEL_FRACTION else "other")

            if inward_name == "cloth" and outward_name == "shadow": votes.append("bed")
            elif inward_name == "shadow" and outward_name == "cloth": votes.append("shadow")
            elif inward_name in ("cloth", "shadow") and outward_name == "other": votes.append("wood")

        if len(votes) < MIN_VOTES: return None

        kind = max(set(votes), key=votes.count)
        support = votes.count(kind) / len(votes)

        if support < MIN_SUPPORT: return None
        return {"kind": kind, "support": support}

    def choose(marks: list[dict], kind: str) -> dict | None:
        # 木板留最长的一条；台面和阴影留最靠近粗边的一条
        group = [mark for mark in marks if mark["kind"] == kind and mark["offset"] >= chosen_min_offset]

        if not group: return None
        if kind == "wood": return max(group, key=lambda mark: (mark["length"], mark["support"]))
        return min(group, key=lambda mark: (mark["offset"], -mark["length"]))
    
    quadrilateral = order_quadrilateral(shape["quadrilateral"])
    center = quadrilateral.mean(axis=0)
    hue_center = shape["hue_center"]
    saturation_center = shape["saturation_center"]
    rows, cols = gray.shape

    # 短边是后面所有像素距离的尺度
    short_side = min(rows, cols)
    distances = tuple(max(1.0, ratio * short_side) for ratio in SIDE_DISTANCE_RATIOS)
    inward_limit = RAIL_INWARD_RATIO * short_side
    outward_limit = RAIL_OUTWARD_RATIO * short_side
    chosen_min_offset = CHOSEN_OFFSET_MIN_RATIO * short_side

    # 边缘和霍夫线段
    min_length = max(1, int(HOUGH_MIN_LENGTH_RATIO * short_side))
    raw_lines = cv.HoughLinesP(
        cv.Canny(gray, CANNY_THRESHOLD_LOW, CANNY_THRESHOLD_HIGH),
        HOUGH_RHO, np.pi / 180, threshold=HOUGH_THRESHOLD,
        minLineLength=min_length, maxLineGap=max(1, int(min_length * HOUGH_GAP_RATIO))
    )

    segments = np.zeros((0, 4), np.float32) if raw_lines is None else np.asarray(raw_lines, dtype=np.float32).reshape(-1, 4)
    segment_delta = segments[:, 2:] - segments[:, :2]
    segment_length = np.linalg.norm(segment_delta, axis=1)
    usable = segment_length > 0
    segment_direction = np.zeros_like(segment_delta)
    segment_direction[usable] = segment_delta[usable] / segment_length[usable, None]
    segment_midpoint = (segments[:, :2] + segments[:, 2:]) / 2

    sides = []
    for index in range(4):

        start, end = quadrilateral[index], quadrilateral[(index + 1) % 4]
        direction = _unit(end - start)
        outward = np.array([-direction[1], direction[0]], dtype=np.float32)
        if np.dot(outward, (start + end) / 2 - center) < 0: outward = -outward

        side_middle = (start + end) / 2
        side_length = float(np.linalg.norm(end - start))
        signed = (segment_midpoint - side_middle) @ outward
        along = (segment_midpoint - side_middle) @ direction

        # 方向、法向偏移、沿线位置都落在库边范围内的线段
        nearby = np.flatnonzero(
            usable & (np.abs(segment_direction @ direction) >= RAIL_PARALLEL) & (signed >= -inward_limit)
            & (signed <= outward_limit) & (np.abs(along) <= side_length * ALONG_SPAN_RATIO)
        )
        marks = []
        for candidate in nearby:

            classified = classify_segment(segments[candidate])
            if classified is None: continue

            marks.append({
                "kind": classified["kind"], "support": classified["support"], "offset": float(signed[candidate]),
                "length": float(segment_length[candidate]), "segment": segments[candidate].astype(np.float32)
            })

        # 有木板用木板，否则用阴影，都没有就留粗边
        wood = choose(marks, "wood")
        shadow = choose(marks, "shadow")
        if wood is not None: used, kind = wood, "wood"
        elif shadow is not None: used, kind = shadow, "shadow"
        else: used, kind = None, "rough"

        if used is None: line = _line_through(start.astype(np.float64), end.astype(np.float64))
        else:

            segment = used["segment"]
            line = _line_through(segment[:2].astype(np.float64), segment[2:].astype(np.float64))

        sides.append({"line": line, "kind": kind})

    return sides


def GetQuad(sides: list[dict], gray: np.ndarray, quadrilateral: np.ndarray) -> list[dict]:
    """第五步：相邻两条库边求交，返回四个角点和每条边的类型。"""

    rows, cols = gray.shape
    center = quadrilateral.mean(axis=0)
    limit = CORNER_MOVE_RATIO * min(rows, cols)

    corners = []
    for index in range(4):

        point = _intersect(sides[(index - 1) % 4]["line"], sides[index]["line"])
        near_rough = point is not None and float(np.linalg.norm(point - quadrilateral[index])) <= limit
        inside_image = point is not None and 0 <= point[0] < cols and 0 <= point[1] < rows
        corners.append(point if inside_image and near_rough else quadrilateral[index])

    corners = np.array(corners, dtype=np.float32)

    if cv.pointPolygonTest(corners, (float(center[0]), float(center[1])), False) < 0:

        corners = quadrilateral
        kinds = ["rough"] * 4
    else: kinds = [side["kind"] for side in sides]

    return [
        {"start": corners[index], "end": corners[(index + 1) % 4], "kind": kinds[index]}
        for index in range(4)
    ]


def main():

    IMAGE_PATH = "D:\\Pool-python\\images\\snooker\\2023 Wuhan Open\\02.png"
    EPOCHS = 10
    
    original = cv.imread(IMAGE_PATH)
    if original is None: raise SystemExit("no image")

    start_time = time.time()
    for i in range(EPOCHS):

        cloth = GetCloth(original)
        if cloth is None: raise SystemExit("no table candidate")

        sides = GetSides(cloth["hue"], cloth["lightness"], cloth["saturation"], cloth["gray"], cloth["table"])
        quadrilateral = GetQuad(sides, cloth["gray"], cloth["rough"])

    end_time = time.time()
    print(f"Average running time: {(end_time - start_time) / EPOCHS} seconds")

    if quadrilateral is None: raise SystemExit("no table candidate")

    quadrilateral = np.rint([side["start"] for side in quadrilateral]).astype(np.int32)
    quadrilateral = np.vstack((quadrilateral, quadrilateral[0]))
    plt.imshow(cv.cvtColor(original, cv.COLOR_BGR2RGB))
    plt.plot(quadrilateral[:, 0], quadrilateral[:, 1], 'r-')
    plt.show()


if __name__ == "__main__": main()