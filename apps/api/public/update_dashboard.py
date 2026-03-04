import re

file_path = "c:\\Users\\svalp\\OneDrive\\Documents\\Development\\Gumroad\\apps\\api\\public\\dashboard.html"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update Section Card Glassmorphism
old_card_css = r'\.section-card \{.*?\n        \}'
new_card_css = """.section-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 32px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.1);
            overflow: visible;
            margin-bottom: 32px;
        }"""
content = re.sub(old_card_css, new_card_css, content, count=1, flags=re.DOTALL)

# 2. Add Stickers and Header Redesign
old_header = r'<header class="mb-12 animate-in">\s*<div class="flex items-center justify-between">\s*<div>\s*<div\s*class="inline-block[^>]*>\s*Server Dashboard\s*</div>\s*<h1 class="text-4xl tracking-tight mb-2">Settings Dashboard</h1>\s*<p class="text-\[rgba\(255,255,255,0\.8\)\] font-medium" style="font-family: \'DM Sans\', sans-serif;">\s*Manage your\s*integrations and server preferences\.</p>\s*</div>'
new_header = """<!-- Playful Background Stickers -->
        <img src="./Icons/World.png" class="absolute top-10 right-20 w-28 opacity-70 sticker pointer-events-none z-0" style="animation-delay: -1s;" alt="World">
        <img src="./Icons/Gumorad.png" class="absolute bottom-20 left-10 w-24 opacity-60 sticker pointer-events-none z-0" style="animation-delay: -4s;" alt="Bag">
        <img src="./Icons/Checkmark.png" class="absolute top-1/2 right-10 w-20 opacity-50 sticker pointer-events-none z-0" style="animation-delay: -2s;" alt="Check">

        <header class="mb-12 animate-in relative z-10">
            <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                <div class="relative">
                    <img src="./Icons/Assistant.png" class="absolute -top-10 -left-12 w-16 sticker pointer-events-none hidden md:block" alt="Assistant">
                    <div class="inline-block px-4 py-1 bg-[#ffffff]/20 text-[#ffffff] rounded-full text-[10px] font-black uppercase tracking-widest mb-4 backdrop-blur-md border border-white/30">
                        Server Dashboard
                    </div>
                    <h1 class="text-5xl md:text-6xl tracking-tight mb-2 font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-blue-200">
                        Settings
                    </h1>
                    <p class="text-[rgba(255,255,255,0.9)] font-medium text-lg max-w-md" style="font-family: 'DM Sans', sans-serif;">
                        Manage your integrations and server preferences.
                    </p>
                </div>"""
content = re.sub(old_header, new_header, content, count=1, flags=re.DOTALL)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("dashboard.html updated successfully!")
