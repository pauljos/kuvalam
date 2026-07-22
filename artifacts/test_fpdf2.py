import os
from fpdf import FPDF

# FONT SETUP
FONT_DIR = "/Users/PaulJoseph/pgent/artifacts/fonts"

pdf = FPDF()
pdf.add_page()
pdf.add_font("NotoMal", fname=os.path.join(FONT_DIR, 'NotoSansMalayalam-Regular.ttf'))
pdf.set_font("NotoMal", size=14)

# Enable text shaping if supported by fpdf2 version
if hasattr(pdf, 'set_text_shaping'):
    pdf.set_text_shaping(True)
    
text_ml = "ആപ്പിൾ കമ്പനി ഓപ്പൺഎഐക്കെതിരെ വ്യാപാര രഹസ്യ ലംഘനത്തിന് കേസ് ഫയൽ ചെയ്തു."
pdf.cell(0, 10, text_ml, new_x="LMARGIN", new_y="NEXT")

pdf.output("/Users/PaulJoseph/pgent/artifacts/malayalam_test.pdf")
print("Test PDF created.")
