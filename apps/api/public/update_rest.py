import re
import os

base_dir = "c:\\Users\\svalp\\OneDrive\\Documents\\Development\\Gumroad\\apps\\api\\public\\"

def update_file(filename, replacements):
    path = os.path.join(base_dir, filename)
    if not os.path.exists(path): return
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    for old, new in replacements:
        content = re.sub(old, new, content, count=1, flags=re.DOTALL)
        
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

# 1. verify-success.html & verify-error.html
stickers_success = """<!-- Playful Background Stickers -->
        <img src="./Icons/ClapStars.png" class="absolute top-20 right-20 w-32 opacity-80 sticker pointer-events-none z-0" style="animation-delay: -2s;" alt="Clap">
        <img src="./Icons/World.png" class="absolute bottom-20 left-10 w-24 opacity-60 sticker pointer-events-none z-0" style="animation-delay: -5s;" alt="World">
        
    <main """

update_file("verify-success.html", [
    (r'<main ', stickers_success)
])

stickers_error = """<!-- Playful Background Stickers -->
        <img src="./Icons/World.png" class="absolute top-20 left-10 w-24 opacity-40 sticker pointer-events-none z-0 grayscale" style="animation-delay: -2s;" alt="Oops">
        <img src="./Icons/Discord.png" class="absolute bottom-40 right-10 w-20 opacity-40 sticker pointer-events-none z-0 grayscale" style="animation-delay: -5s;" alt="Discord">
        
    <main """

update_file("verify-error.html", [
    (r'<main ', stickers_error)
])

# 2. sign-in-redirect.html
stickers_redirect = """<!-- Playful Background Stickers -->
        <img src="./Icons/World.png" class="absolute top-32 right-1/4 w-32 opacity-80 sticker pointer-events-none z-0" style="animation-delay: -1s;" alt="World">
        <img src="./Icons/Assistant.png" class="absolute bottom-32 left-1/4 w-24 opacity-60 sticker pointer-events-none z-0" style="animation-delay: -4s;" alt="Assistant">
        
    <main """

update_file("sign-in-redirect.html", [
    (r'<main ', stickers_redirect)
])

# 3. jinxxy-setup.html
jinxxy_stickers = """<!-- Playful Background Stickers -->
        <img src="./Icons/Jinxxy.png" class="absolute top-20 right-10 w-32 opacity-80 sticker pointer-events-none z-0" style="animation-delay: -2s;" alt="Jinxxy">
        <img src="./Icons/KeyCloud.png" class="absolute bottom-10 left-10 w-24 opacity-60 sticker pointer-events-none z-0" style="animation-delay: -5s;" alt="Cloud">

    <div class="cursor-dot"></div>"""

jinxxy_css_old = r'\.setup-card \{.*?\n        \}'
jinxxy_css_new = """.setup-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 32px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.1);
            overflow: visible;
        }"""
        
update_file("jinxxy-setup.html", [
    (r'<div class="cursor-dot"></div>', jinxxy_stickers),
    (jinxxy_css_old, jinxxy_css_new)
])

# 4. discord-role-setup.html
discord_stickers = """<!-- Playful Background Stickers -->
        <img src="./Icons/Discord.png" class="absolute top-20 left-10 w-32 opacity-80 sticker pointer-events-none z-0" style="animation-delay: -1s;" alt="Discord">
        <img src="./Icons/Assistant.png" class="absolute bottom-20 right-10 w-24 opacity-60 sticker pointer-events-none z-0" style="animation-delay: -6s;" alt="Assistant">

    <nav class="w-full """

update_file("discord-role-setup.html", [
    (r'<nav class="w-full ', discord_stickers)
])

print("Remaining pages updated with stickers and glassmorphism.")
