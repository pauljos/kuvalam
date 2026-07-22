# -*- coding: utf-8 -*-
import os
from fpdf import FPDF

class MalayalamNewsletter(FPDF):
    def header(self):
        # Decorative top border
        self.set_fill_color(30, 41, 59) # Slate 800
        self.rect(0, 0, 210, 8, 'F')
        
    def footer(self):
        self.set_y(-15)
        self.set_font('NotoMalayalam', '', 9)
        self.set_text_color(100, 116, 139) # Slate 500
        self.cell(0, 10, 'പേജ് %s' % self.page_no(), 0, new_x="RIGHT", new_y="TOP", align='C')

def create_newsletter():
    OUTPUT_PDF = "/Users/PaulJoseph/pgent/artifacts/malayalam_newsletter.pdf"
    pdf = MalayalamNewsletter()
    if hasattr(pdf, 'set_text_shaping'):
        pdf.set_text_shaping(True)
    pdf.set_margins(18, 20, 18)
    pdf.add_page()
    
    # Register Noto Sans Malayalam Fonts
    font_reg = "/Users/PaulJoseph/pgent/artifacts/fonts/NotoSansMalayalam-Regular.ttf"
    font_bold = "/Users/PaulJoseph/pgent/artifacts/fonts/NotoSansMalayalam-Bold.ttf"
    
    pdf.add_font('NotoMalayalam', '', font_reg)
    pdf.add_font('NotoMalayalam', 'B', font_bold)
    
    # ─── HEADER BANNER ───
    pdf.set_fill_color(248, 250, 252) # Light blue/slate background
    pdf.rect(18, 15, 174, 38, 'F')
    
    # Header Border
    pdf.set_draw_color(226, 232, 240)
    pdf.set_line_width(1)
    pdf.rect(18, 15, 174, 38, 'D')
    
    # Title
    pdf.set_xy(22, 18)
    pdf.set_font('NotoMalayalam', 'B', 20)
    pdf.set_text_color(15, 23, 42) # Slate 900
    pdf.cell(0, 10, 'മലയാളം ടെക് വാർത്താ പത്രിക', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    
    # Subtitle
    pdf.set_font('NotoMalayalam', '', 11)
    pdf.set_text_color(71, 85, 105) # Slate 600
    pdf.set_x(22)
    pdf.cell(0, 6, 'ലോകത്തിലെ ഏറ്റവും പുതിയ സാങ്കേതികവിദ്യ വാർത്തകൾ മലയാളത്തിൽ', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    
    # Meta (Date / Issue)
    pdf.set_font('NotoMalayalam', '', 9.5)
    pdf.set_text_color(100, 116, 139) # Slate 500
    pdf.set_xy(22, 42)
    pdf.cell(50, 6, 'ലക്കം: 01', 0, new_x="RIGHT", new_y="TOP", align='L')
    pdf.cell(124, 6, 'തീയതി: 20 ജൂലൈ 2026', 0, new_x="LMARGIN", new_y="NEXT", align='R')
    
    pdf.ln(12)
    
    # ─── INTRODUCTION ───
    pdf.set_fill_color(241, 245, 249) # Slate 100
    pdf.set_draw_color(203, 213, 225) # Slate 300
    pdf.set_line_width(0.5)
    
    # Intro box
    pdf.set_x(18)
    pdf.set_font('NotoMalayalam', '', 11)
    pdf.set_text_color(51, 65, 85) # Slate 700
    
    intro_text = (
        "സ്വാഗതം! ഈ ആഴ്ചയിലെ പ്രധാന സാങ്കേതികവിദ്യ വാർത്തകൾ ഞങ്ങൾ ഇവിടെ അവതരിപ്പിക്കുന്നു. "
        "കൃത്രിമബുദ്ധി (AI), ഇലക്ട്രിക് വ്യോമയാനം, യൂറോപ്യൻ യൂണിയനിലെ ഡിജിറ്റൽ നിയന്ത്രണങ്ങൾ "
        "എന്നിവയിലെ ഏറ്റവും പുതിയ മാറ്റങ്ങൾ ഈ ലക്കത്തിൽ വിശദമായി വായിക്കാം."
    )
    pdf.multi_cell(174, 7, intro_text, border=1, align='L', fill=True)
    
    pdf.ln(10)
    
    # ─── NEWS STORIES ───
    
    # --- Story 1 ---
    pdf.set_font('NotoMalayalam', 'B', 13.5)
    pdf.set_text_color(30, 41, 59) # Slate 800
    pdf.cell(0, 8, '1. ചൈനയുടെ AI മോഡലുകൾ അമേരിക്കൻ ആധിപത്യത്തിന് വെല്ലുവിളി', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    
    # Source / Date
    pdf.set_font('NotoMalayalam', '', 9)
    pdf.set_text_color(148, 163, 184) # Slate 400
    pdf.cell(0, 5, 'പ്രസിദ്ധീകരിച്ചത്: 20 ജൂലൈ 2026 | ഉറവിടം: Tech Crunch', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    pdf.ln(2)
    
    pdf.set_font('NotoMalayalam', '', 10.5)
    pdf.set_text_color(51, 65, 85) # Slate 700
    story_1_body = (
        "ബീജിങ്ങ് ആസ്ഥാനമായി പ്രവർത്തിക്കുന്ന Moonshot AI കമ്പനി പുതിയ ഭാഷാ മോഡൽ ആയ "
        "'Kimi K3' കഴിഞ്ഞ ദിവസം പുറത്തിറക്കി. കമ്പനിയുടെ അവകാശവാദ പ്രകാരം, നിർദ്ദിഷ്ട പരീക്ഷണങ്ങളിൽ "
        "ഈ മോഡൽ അമേരിക്കൻ കമ്പനികളായ OpenAI, Anthropic എന്നിവയുടെ പ്രധാന മോഡലുകളെക്കാൾ മികച്ച "
        "പ്രകടനം കാഴ്ചവച്ചു. അതോടൊപ്പം അലിബാബ ഗ്രൂപ്പും തങ്ങളുടെ പ്രമുഖ മോഡൽ ആയ Qwen 2.5-ന്റെ "
        "ഏറ്റവും പുതിയ പതിപ്പ് അവതരിപ്പിച്ചു. കുറഞ്ഞ ചെലവിൽ ഉയർന്ന പ്രകടനം നൽകുന്ന ഈ ചൈനീസ് "
        "AI മോഡലുകൾ അമേരിക്കയിലെ സിലിക്കൺ വാലി കമ്പനികൾക്ക് കടുത്ത വെല്ലുവിളിയാണ് ഉയർത്തുന്നത്."
    )
    pdf.multi_cell(174, 6.5, story_1_body, 0, 'L')
    pdf.ln(8)
    
    # Divider Line
    pdf.set_draw_color(241, 245, 249)
    pdf.line(18, pdf.get_y(), 192, pdf.get_y())
    pdf.ln(6)
    
    # --- Story 2 ---
    pdf.set_font('NotoMalayalam', 'B', 13.5)
    pdf.set_text_color(30, 41, 59)
    pdf.cell(0, 8, '2. ആർച്ചർ ഏവിയേഷൻ, ആൻഡ്രിൽ സൈനിക ഇലക്ട്രിക് വിമാനം പുറത്തിറക്കി', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    
    pdf.set_font('NotoMalayalam', '', 9)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 5, 'പ്രസിദ്ധീകരിച്ചത്: 20 ജൂലൈ 2026 | ഉറവിടം: Aviation Week', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    pdf.ln(2)
    
    pdf.set_font('NotoMalayalam', '', 10.5)
    pdf.set_text_color(51, 65, 85)
    story_2_body = (
        "ഇലക്ട്രിക് വ്യോമയാന മേഖലയിലെ പ്രമുഖരായ ആർച്ചർ ഏവിയേഷൻ, പ്രതിരോധ സാങ്കേതിക കമ്പനിയായ "
        "ആൻഡ്രിലുമായി ചേർന്ന് 'Thunder' എന്ന പുതിയ ഇലക്ട്രിക് വെർട്ടിക്കൽ ടേക്കോഫ് ആൻഡ് ലാൻഡിങ് (eVTOL) "
        "വിമാനം പുറത്തിറക്കി. നഗരങ്ങളിലെ വ്യോമഗതാഗത ആവശ്യങ്ങൾക്ക് പുറമെ, സൈനിക ആവശ്യങ്ങൾക്കും "
        "പ്രതിരോധ പ്രവർത്തനങ്ങൾക്കും അനുയോജ്യമായ തരത്തിലാണ് ഇത് രൂപകൽപ്പന ചെയ്തിരിക്കുന്നത്. "
        "ഉയർന്ന പെർഫോമൻസും കുറഞ്ഞ ശബ്ദ മലിനീകരണവും ഉള്ള ഈ വിമാനം പ്രതിരോധ രംഗത്ത് വലിയ മുന്നേറ്റമുണ്ടാക്കുമെന്നാണ് "
        "വിലയിരുത്തപ്പെടുന്നത്."
    )
    pdf.multi_cell(174, 6.5, story_2_body, 0, 'L')
    pdf.ln(8)
    
    # Divider Line
    pdf.line(18, pdf.get_y(), 192, pdf.get_y())
    pdf.ln(6)
    
    # --- Story 3 ---
    pdf.set_font('NotoMalayalam', 'B', 13.5)
    pdf.set_text_color(30, 41, 59)
    pdf.cell(0, 8, '3. അലിഎക്സ്പ്രസ്സിന് യൂറോപ്യൻ യൂണിയൻ 63 കോടി ഡോളർ പിഴ ചുമത്തി', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    
    pdf.set_font('NotoMalayalam', '', 9)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 5, 'പ്രസിദ്ധീകരിച്ചത്: 19 ജൂലൈ 2026 | ഉറവിടം: Wall Street Journal', 0, new_x="LMARGIN", new_y="NEXT", align='L')
    pdf.ln(2)
    
    pdf.set_font('NotoMalayalam', '', 10.5)
    pdf.set_text_color(51, 65, 85)
    story_3_body = (
        "ചൈനീസ് ഉടമസ്ഥതയിലുള്ള പ്രമുഖ ഓൺലൈൻ ഷോപ്പിംഗ് പ്ലാറ്റ്ഫോമായ അലിഎക്സ്പ്രസ്സിന് (AliExpress) "
        "യൂറോപ്യൻ കമ്മീഷൻ 63 കോടി ഡോളർ (ഏകദേശം 550 മില്യൺ യൂറോ) പിഴ ചുമത്തി. ഉപഭോക്തൃ സംരക്ഷണം, "
        "വ്യാജ ഉൽപ്പന്നങ്ങളുടെ വിൽപ്പന തടയൽ എന്നിവയുമായി ബന്ധപ്പെട്ട യൂറോപ്യൻ യൂണിയന്റെ 'ഡിജിറ്റൽ സർവീസസ് ആക്ട്' (DSA) "
        "വ്യവസ്ഥകൾ ലംഘിച്ചതിനാണ് ഈ കടുത്ത നടപടി. ഡിജിറ്റൽ മേഖലയിലെ ഉപഭോക്താക്കളുടെ സുരക്ഷയും അവകാശങ്ങളും "
        "സംരക്ഷിക്കുന്നതിൽ പരാജയപ്പെടുന്ന വൻകിട കമ്പനികൾക്ക് എതിരെയുള്ള മുന്നറിയിപ്പാണ് ഈ നടപടിയെന്ന് യൂറോപ്യൻ യൂണിയൻ "
        "വ്യക്തമാക്കി."
    )
    pdf.multi_cell(174, 6.5, story_3_body, 0, 'L')
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(OUTPUT_PDF), exist_ok=True)
    
    # Output PDF
    pdf.output(OUTPUT_PDF)
    print(f"✅ Premium Malayalam Newsletter PDF generated successfully at: {OUTPUT_PDF}")

if __name__ == "__main__":
    create_newsletter()
