#!/usr/bin/env python3
"""
Generate a Malayalam Technology News Newsletter as a beautifully formatted PDF.
Uses ReportLab and NotoSansMalayalam font for proper Unicode rendering.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm, cm
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable, Image
)
from datetime import datetime
import os

# ============================================================================
# FONT SETUP
# ============================================================================
FONT_DIR = "/Users/PaulJoseph/pgent/artifacts/fonts"
pdfmetrics.registerFont(TTFont('NotoMal', os.path.join(FONT_DIR, 'NotoSansMalayalam-Regular.ttf')))
pdfmetrics.registerFont(TTFont('NotoMal-Bold', os.path.join(FONT_DIR, 'NotoSansMalayalam-Bold.ttf')))
pdfmetrics.registerFont(TTFont('NotoSans', os.path.join(FONT_DIR, 'NotoSans-Regular.ttf')))
pdfmetrics.registerFont(TTFont('NotoSans-Bold', os.path.join(FONT_DIR, 'NotoSans-Bold.ttf')))
pdfmetrics.registerFont(TTFont('NotoSans-Italic', os.path.join(FONT_DIR, 'NotoSans-Italic.ttf')))

# ============================================================================
# COLOR PALETTE (TechCrunch-inspired)
# ============================================================================
COL_PRIMARY = colors.HexColor('#0a8935')       # TechCrunch green
COL_ACCENT = colors.HexColor('#5631ea')        # Purple
COL_DARK = colors.HexColor('#212623')          # Near-black
COL_GRAY_900 = colors.HexColor('#535554')
COL_GRAY_700 = colors.HexColor('#6c7571')
COL_GRAY_500 = colors.HexColor('#b5c0bc')
COL_GRAY_300 = colors.HexColor('#d2dcd7')
COL_GRAY_100 = colors.HexColor('#edf1ef')
COL_BG_SOFT = colors.HexColor('#fafbf9')
COL_RED = colors.HexColor('#e21c1c')
COL_WHITE = colors.white

# ============================================================================
# PARAGRAPH STYLES
# ============================================================================
styles = getSampleStyleSheet()

style_newsletter_title = ParagraphStyle(
    'NLTitle', fontName='NotoMal-Bold', fontSize=34, leading=42,
    textColor=COL_WHITE, alignment=TA_LEFT, spaceAfter=4
)
style_newsletter_subtitle = ParagraphStyle(
    'NLSubtitle', fontName='NotoSans', fontSize=13, leading=16,
    textColor=colors.HexColor('#68f176'), alignment=TA_LEFT
)
style_newsletter_meta = ParagraphStyle(
    'NLMeta', fontName='NotoSans', fontSize=9, leading=12,
    textColor=colors.HexColor('#b5c0bc'), alignment=TA_LEFT
)

style_article_category = ParagraphStyle(
    'Cat', fontName='NotoSans-Bold', fontSize=9, leading=12,
    textColor=COL_PRIMARY, alignment=TA_LEFT, spaceAfter=2,
    letterSpacing=1.5
)
style_article_headline = ParagraphStyle(
    'Headline', fontName='NotoMal-Bold', fontSize=20, leading=26,
    textColor=COL_DARK, alignment=TA_LEFT, spaceAfter=6
)
style_article_byline = ParagraphStyle(
    'Byline', fontName='NotoSans-Italic', fontSize=9, leading=12,
    textColor=COL_GRAY_700, alignment=TA_LEFT, spaceAfter=10
)
style_article_body = ParagraphStyle(
    'Body', fontName='NotoMal', fontSize=11, leading=17,
    textColor=COL_DARK, alignment=TA_JUSTIFY, spaceAfter=6
)
style_article_source = ParagraphStyle(
    'Source', fontName='NotoSans', fontSize=8, leading=10,
    textColor=COL_GRAY_700, alignment=TA_LEFT
)

style_section_intro = ParagraphStyle(
    'Intro', fontName='NotoMal', fontSize=11.5, leading=18,
    textColor=COL_DARK, alignment=TA_JUSTIFY, spaceAfter=12
)

style_footer_text = ParagraphStyle(
    'Footer', fontName='NotoSans', fontSize=9, leading=12,
    textColor=COL_GRAY_700, alignment=TA_CENTER
)
style_footer_text_ml = ParagraphStyle(
    'FooterML', fontName='NotoMal', fontSize=9, leading=12,
    textColor=COL_GRAY_700, alignment=TA_CENTER
)

# ============================================================================
# CONTENT - 3 Recent Tech Updates (translated/adapted into Malayalam)
# ============================================================================
# Story 1: Apple vs OpenAI lawsuit (TechCrunch - Anthony Ha, July 19, 2026)
STORY_1 = {
    "category_en": "AI · HARDWARE",
    "category_ml": "എഐ · ഹാർഡ്‌വെയർ",
    "headline_ml": "ആപ്പിളിന്റെ വ്യാപാര രഹസ്യ കേസ് ഓപ്പൺഎഐയുടെ ഹാർഡ്‌വെയർ പദ്ധതികളെ തടസ്സപ്പെടുത്തുമോ?",
    "byline": "റിപ്പോർട്ട്: ആന്തണി ഹാ (Anthony Ha) · ടെക്ക്ക്റാഞ്ച് · ജൂലൈ 19, 2026",
    "paragraphs_ml": [
        "ആപ്പിൾ കമ്പനി ഓപ്പൺഎഐക്കെതിരെ വ്യാപാര രഹസ്യ ലംഘനത്തിന് കേസ് ഫയൽ ചെയ്തത് ആ കമ്പനിയുടെ ഹാർഡ്‌വെയർ രംഗത്തേക്കുള്ള അഭിലാഷ പദ്ധതികളെ ഗുരുതരമായി ബാധിച്ചേക്കാം. കഴിഞ്ഞ വെള്ളിയാഴ്ചയാണ് കേസ് സമർപ്പിച്ചത്. ഓപ്പൺഎഐയുടെ ചീഫ് ഹാർഡ്‌വെയർ ഓഫീസർ വരെ എത്തുന്ന ക്രമരഹിതമായ പെരുമാറ്റത്തിന്റെ പാറ്റേൺ ആരോപിക്കുന്ന കേസിൽ, നിലവിൽ ഓപ്പൺഎഐയിൽ 400-ലധികം മുൻ ആപ്പിൾ ജീവനക്കാർ ജോലി ചെയ്യുന്നുവെന്ന ഗുരുതരമായ ആരോപണവും ഉന്നയിക്കപ്പെട്ടിട്ടുണ്ട്.",
        "ഈ വർഷം അവസാനത്തോടെ ഓപ്പൺഎഐയുടെ പ്രതീക്ഷിക്കുന്ന ഐപിഒ പോലുള്ള നിർണായക ഘട്ടത്തിലാണ് കേസ് എത്തിയിരിക്കുന്നത് എന്നതാണ് ഏറ്റവും ആശങ്കാജനകമായ വസ്തുത. ഓപ്പൺഎഐ ഇതുവരെ നൽകിയ പ്രതികരണങ്ങൾ വളരെ ശ്രദ്ധയോടെ തിരഞ്ഞെടുത്തവയാണ്. അവർ ആരോപണങ്ങളെ നേരിട്ട് നിഷേധിക്കാതെ നിയമ പോരാട്ടത്തിനുള്ള തയ്യാറെടുപ്പുകൾ ആരംഭിച്ചിട്ടുണ്ട്. എന്നാൽ, ആപ്പിളിന്റെ കേസിൽ ഉന്നയിക്കപ്പെട്ട വ്യാപാര രഹസ്യ ലംഘനത്തിന്റെ ഗൗരവം കണക്കിലെടുക്കുമ്പോൾ, ഓപ്പൺഎഐയുടെ സ്വന്തം ഹാർഡ്‌വെയർ ഉപകരണങ്ങൾ വികസിപ്പിക്കുന്നതിനുള്ള പദ്ധതികൾ കാര്യമായ തടസ്സങ്ങൾ നേരിട്ടേക്കാം.",
        "ജോണി ഐവിയുമായി ചേർന്നുള്ള സഹകരണത്തിലൂടെ ഓപ്പൺഎഐ ഒരു സ്ക്രീൻലെസ്സ് സ്പീക്കർ ഉപകരണം വികസിപ്പിക്കുന്നുണ്ടെന്ന റിപ്പോർട്ടുകളും ഉണ്ട്. ഈ ഉപകരണം വിപണിയിൽ എത്തുന്നതിന് മുമ്പായി തന്നെ നിയമ വിവാദങ്ങൾ കമ്പനിയുടെ വളർച്ചാ പദ്ധതികളെ പ്രതികൂലമായി ബാധിക്കുമെന്ന് വിദഗ്ധർ വിലയിരുത്തുന്നു.",
    ],
    "source_url": "https://techcrunch.com/2026/07/19/can-an-apple-lawsuit-derail-openais-hardware-plans/"
}

# Story 2: Jensen Huang's Japan visit (TechCrunch - Kate Park, July 19, 2026)
STORY_2 = {
    "category_en": "AI · SEMICONDUCTORS",
    "category_ml": "എഐ · സെ
