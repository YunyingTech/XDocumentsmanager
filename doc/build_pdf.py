from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "XDocuments-使用说明.pdf"
FONT = Path("C:/Windows/Fonts/msyh.ttc")
if not FONT.exists():
    FONT = Path("C:/Windows/Fonts/simsun.ttc")
pdfmetrics.registerFont(TTFont("ManualCN", str(FONT), subfontIndex=0))

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverTitleCN", fontName="ManualCN", fontSize=27, leading=36, textColor=colors.HexColor("#153d52"), alignment=TA_CENTER, spaceAfter=8 * mm))
styles.add(ParagraphStyle(name="SubtitleCN", fontName="ManualCN", fontSize=11, leading=18, textColor=colors.HexColor("#52636b"), alignment=TA_CENTER, spaceAfter=5 * mm))
styles.add(ParagraphStyle(name="HeadingCN", fontName="ManualCN", fontSize=17, leading=24, textColor=colors.HexColor("#176b67"), spaceBefore=3 * mm, spaceAfter=4 * mm, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyCN", fontName="ManualCN", fontSize=9.5, leading=16, textColor=colors.HexColor("#263238"), spaceAfter=2.3 * mm, wordWrap="CJK"))
styles.add(ParagraphStyle(name="SmallCN", fontName="ManualCN", fontSize=8, leading=12, textColor=colors.HexColor("#63737a"), alignment=TA_CENTER))

PAGE_W, PAGE_H = A4
doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=17 * mm, leftMargin=17 * mm, topMargin=17 * mm, bottomMargin=17 * mm, title="XDocuments Manager 使用说明", author="XDocuments Manager")
content_w = PAGE_W - 34 * mm
story = []


def para(text, style="BodyCN"):
    story.append(Paragraph(text, styles[style]))


def image(name, width=content_w):
    path = ROOT / "screenshots" / name
    source = Image(str(path))
    height = width * source.imageHeight / source.imageWidth
    img = Image(str(path), width=width, height=height)
    story.append(img)


def section(title, paragraphs, screenshot=None, new_page=True):
    if new_page:
        story.append(PageBreak())
    group = [Paragraph(title, styles["HeadingCN"])]
    group.extend(Paragraph(text, styles["BodyCN"]) for text in paragraphs)
    story.append(KeepTogether(group))
    if screenshot:
        story.append(Spacer(1, 2 * mm))
        image(screenshot)


story.append(Spacer(1, 24 * mm))
para("XDocuments Manager", "CoverTitleCN")
para("PDF 文档资料库 · 使用说明", "SubtitleCN")
para("版本 0.1.11　|　Windows / macOS", "SubtitleCN")
story.append(Spacer(1, 12 * mm))
image("01-文件工作区.png", content_w)
story.append(Spacer(1, 8 * mm))
para("管理本地磁盘与 SMB 共享目录中的 PDF。文件保留在原位置，索引和本机 OCR 在本地处理。", "SubtitleCN")
para("截图中的资料夹、文件、日志与更新版本均为演示数据。", "SmallCN")

section("1. 首次启动", [
    "首次启动会显示初始化阶段。数据库、搜索索引和搜索服务准备期间，窗口显示加载动画和当前阶段；初始化完成后进入文件页。启动时也可打开运行日志查看诊断信息。",
    "RapidOCR 是默认 OCR 引擎。首次使用时，程序会在应用数据目录准备独立运行环境，可能需要等待。配置 MinerU 外部 OCR 服务时，所选文件会发送到该服务。",
], "01-文件工作区.png")

section("2. 添加资料夹并建立索引", [
    "1. 在左侧选择“文件夹”，点击“添加文件夹”；也可点击“已索引文件夹”旁的加号。",
    "2. 选择本地目录或可访问的 SMB 共享目录。确认添加后，程序开始增量索引。",
    "3. 后续扫描会比较文件大小和修改时间，只重新处理新增或变更的 PDF。任务中心显示进度；多个资料夹的任务分别显示状态。",
    "需要重新计算全部文件索引时，在文件页工具栏使用“全量重新索引”。该操作会重新处理所选资料夹的全部 PDF。",
], "02-资料夹管理.png")

section("3. 浏览文件和预览 PDF", [
    "在左侧选择资料夹即可浏览已索引文件。表格支持分页和排序；点击文件行可选中文件，并在可用时打开内置 PDF 阅读器预览。文件原件不会被移动。",
], "03-文件浏览.png")

section("4. 搜索", [
    "选择左侧“搜索”，输入关键词并提交。搜索覆盖已索引资料库，可使用筛选项缩小范围。查看匹配片段和文件信息，选择结果打开 PDF。",
    "设置中可选配 OpenAI 兼容模型扩展查询词。该功能向模型发送查询词，不发送 PDF 正文；关闭时仍可使用常规搜索。搜索服务不可用时程序可使用嵌入式 Tantivy 后端。",
], "04-搜索.png")

section("5. OCR 识别", [
    "在“OCR 识别”页面选择引擎和语言，再选择待处理文件并提交；也可将全部待处理文件加入队列。任务中心显示排队、处理中、完成或失败状态。内容变更的 PDF 会重新进入待处理范围。",
    "RapidOCR 是默认引擎，可选自动设备或 CPU，并设置最大并发数（上限 256）。Windows OCR 使用系统识别能力；PaddleOCR 提供替代引擎和设备模式。",
    "MinerU 是可选外部服务；提交识别时，所选文件会发送至配置的服务端点。OCR 输出目录与引擎状态可在页面查看。",
], "05-OCR.png")

section("6. 设置与后台更新", [
    "设置页可调整界面语言、主题、搜索模型和 OCR 运行选项，并查看搜索后端状态与应用版本。",
    "程序启动后会自动查询 GitHub 最新 Release。发现新版本后可在后台下载；下载完成不会自动替换或重启程序。进入更新区域，点击“重启并安装”才会应用已下载版本。",
], "06-设置与更新.png")

section("7. 运行日志", [
    "点击顶部“运行日志”切换到日志视图。日志读取在后台执行，读取期间显示加载状态并避免重复刷新；程序只保留近期日志。可刷新日志并查看诊断信息。",
], "07-运行日志.png")

section("8. 常见问题与数据说明", [
    "文件未显示：确认资料夹已添加、索引任务已完成，并检查本地目录权限或 SMB 连接。搜索结果未更新：等待索引完成后再搜索；必要时重新扫描或使用全量重新索引。",
    "OCR 不可用：在 OCR 页面查看引擎状态。首次准备运行环境可能需要时间；检查网络、磁盘空间和安装状态后重试。启动或日志读取较慢时，可先查看日志中的错误，再重启程序。",
    "更新已下载但版本未变化：后台下载不会自动安装。保存工作后，在设置更新区域点击“重启并安装”。",
    "本地索引、RapidOCR、Windows OCR 和 PaddleOCR 在本机运行，PDF 保留在原目录。配置 MinerU 时所选文件会发送到相应服务；可选查询扩展发送查询词，不发送 PDF 内容。数据库位于应用数据目录。",
])


def footer(canvas, document):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d8e1e3"))
    canvas.line(17 * mm, 12 * mm, PAGE_W - 17 * mm, 12 * mm)
    canvas.setFont("ManualCN", 8)
    canvas.setFillColor(colors.HexColor("#63737a"))
    canvas.drawString(17 * mm, 7.5 * mm, "XDocuments Manager · 使用说明 · v0.1.11")
    canvas.drawRightString(PAGE_W - 17 * mm, 7.5 * mm, str(document.page))
    canvas.restoreState()


doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
