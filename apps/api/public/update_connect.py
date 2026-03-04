import re

file_path = "c:\\Users\\svalp\\OneDrive\\Documents\\Development\\Gumroad\\apps\\api\\public\\connect.html"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Background SVGs to Stickers
old_svgs = r'<!-- Background SVGs -->.*?</svg>.*?</svg>'
new_stickers = """<!-- Playful Background Stickers -->
        <img src="./Icons/World.png" class="absolute top-20 left-10 w-24 opacity-60 sticker pointer-events-none" style="animation-delay: -2s;" alt="World">
        <img src="./Icons/Link.png" class="absolute bottom-10 right-20 w-32 opacity-80 sticker pointer-events-none" style="animation-delay: -5s;" alt="Link">
        <img src="./Icons/Assistant.png" class="absolute top-40 right-10 w-20 opacity-40 sticker pointer-events-none z-0" style="animation-delay: -1s;" alt="Assistant">"""
content = re.sub(old_svgs, new_stickers, content, flags=re.DOTALL)

# 2. Header
old_header = r'<div class="text-center mb-10">.*?</div>'
new_header = """<div class="text-center mb-10 relative">
                <div class="inline-block px-4 py-1 bg-[#ffffff]/20 text-[#ffffff] rounded-full text-[10px] font-black uppercase tracking-widest mb-4 backdrop-blur-md border border-white/30">
                    Sync Progress
                </div>
                <h1 class="text-4xl md:text-6xl text-[#ffffff] mb-4 relative inline-block">
                    Connect<br> Your <span class="bg-gradient-to-r from-[#0ea5e9] to-[#00f3ff] bg-clip-text text-transparent">Accounts</span>
                    <img src="./Icons/Checkmark.png" class="absolute -top-6 -right-12 w-16 sticker pointer-events-none hidden md:block" alt="Check">
                </h1>
                <p class="text-[rgba(255,255,255,0.9)] font-medium leading-relaxed max-w-sm mx-auto text-lg" style="font-family: 'DM Sans', sans-serif;">
                    Link your platforms to unlock custom roles, tiered rewards, and seamless profile sync.
                </p>
            </div>"""
# Careful, we only want to replace the FIRST matching div with text-center mb-10
content = re.sub(old_header, new_header, content, count=1, flags=re.DOTALL)

# 3. Buttons
old_buttons = r'<div class="space-y-4">.*?</div>'
new_buttons = """<div class="space-y-4 relative z-10">

                <button type="button"
                    class="w-full flex items-center justify-between p-5 rounded-3xl bg-[rgba(88,101,242,0.9)] backdrop-blur-md text-white shadow-xl shadow-[#5865F2]/30 opacity-95 cursor-default border border-white/20 transition-transform hover:scale-[1.02]"
                    data-platform="discord">
                    <div class="flex items-center gap-5">
                        <img class="w-12 h-12 sticker drop-shadow-lg" src="./Icons/Discord.png" alt="Discord">
                        <div class="text-left">
                            <span class="font-bold tracking-tight text-xl block" style="font-family: 'Plus Jakarta Sans', sans-serif;">Discord</span>
                            <span class="text-sm opacity-80" style="font-family: 'DM Sans', sans-serif;">Identity Provider</span>
                        </div>
                    </div>
                    <div class="flex items-baseline gap-2 bg-white/20 px-4 py-1.5 rounded-full">
                        <div class="w-2 h-2 rounded-full bg-[#00e676] shadow-[0_0_8px_#00e676]"></div>
                        <span class="text-xs font-black uppercase tracking-widest" style="font-family: 'Plus Jakarta Sans', sans-serif;">Connected</span>
                    </div>
                </button>

                <button type="button"
                    class="platform-btn w-full flex items-center justify-between p-5 rounded-3xl bg-[rgba(255,144,232,0.9)] backdrop-blur-md text-white shadow-xl shadow-[#ff90e8]/30 group border border-white/20"
                    data-platform="gumroad">
                    <div class="flex items-center gap-5">
                        <img class="w-12 h-12 sticker drop-shadow-lg" src="./Icons/Gumorad.png" alt="Gumroad">
                        <div class="text-left text-black">
                            <span class="font-bold tracking-tight text-xl block" style="font-family: 'Plus Jakarta Sans', sans-serif;">Gumroad</span>
                            <span class="text-sm opacity-80 font-medium" style="font-family: 'DM Sans', sans-serif;">Creator Store</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 text-black bg-black/10 px-4 py-2 rounded-full backdrop-blur-md group-hover:bg-black/20 transition-colors">
                        <span class="connect-badge text-xs font-black uppercase tracking-widest" style="font-family: 'Plus Jakarta Sans', sans-serif;">Connect</span>
                        <svg class="w-4 h-4 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                            <path d="M5 12h14M12 5l7 7-7 7"></path>
                        </svg>
                    </div>
                </button>

                <button type="button"
                    class="platform-btn w-full flex items-center justify-between p-5 rounded-3xl bg-[rgba(145,70,255,0.9)] backdrop-blur-md text-white shadow-xl shadow-[#9146FF]/30 group border border-white/20"
                    data-platform="jinxxy">
                    <div class="flex items-center gap-5">
                        <img class="w-12 h-12 sticker drop-shadow-lg" src="./Icons/Jinxxy.png" alt="Jinxxy">
                        <div class="text-left">
                            <span class="font-bold tracking-tight text-xl block" style="font-family: 'Plus Jakarta Sans', sans-serif;">Jinxxy</span>
                            <span class="text-sm opacity-80 font-medium" style="font-family: 'DM Sans', sans-serif;">Marketplace</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 bg-white/20 px-4 py-2 rounded-full backdrop-blur-md group-hover:bg-white/30 transition-colors">
                        <span class="connect-badge text-xs font-black uppercase tracking-widest" style="font-family: 'Plus Jakarta Sans', sans-serif;">Connect</span>
                        <svg class="w-4 h-4 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                            <path d="M5 12h14M12 5l7 7-7 7"></path>
                        </svg>
                    </div>
                </button>
            </div>"""
content = re.sub(old_buttons, new_buttons, content, count=1, flags=re.DOTALL)

# 4. Settings & Done sections
old_settings = r'<!-- Settings Section -->.*?Done — Continue Setup in Discord</span>\n                </button>'
new_settings = """<!-- Settings Section -->
            <div class="mt-8 pt-6 border-t border-[rgba(255,255,255,0.1)]/60 relative z-10">
                <div class="flex items-center justify-between bg-white/5 p-4 rounded-2xl border border-white/10 hover:bg-white/10 transition-colors">
                    <div>
                        <h3 class="text-sm font-bold text-[#ffffff]" style="font-family: 'Plus Jakarta Sans', sans-serif;">Allow Mismatched Emails</h3>
                        <p class="text-xs text-[rgba(255,255,255,0.7)] mt-1" style="font-family: 'DM Sans', sans-serif;">Buyers can verify with different emails.</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer ml-4">
                        <input type="checkbox" id="mismatched-emails-toggle" class="sr-only peer">
                        <div class="w-11 h-6 bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0ea5e9]"></div>
                    </label>
                </div>
            </div>

            <div class="mt-8 pt-6 border-t border-[rgba(255,255,255,0.1)]/60 flex flex-col gap-4 relative z-10">
                <button id="done-btn" class="w-full py-5 rounded-full bg-white text-[#0ea5e9] font-black text-lg uppercase tracking-widest shadow-xl shadow-white/20 hover:bg-[#0ea5e9] hover:text-white transition-all platform-btn flex justify-center items-center gap-3 group">
                    <span>Continue in Discord</span>
                    <svg class="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3"></path>
                    </svg>
                </button>"""
content = re.sub(old_settings, new_settings, content, count=1, flags=re.DOTALL)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("connect.html updated successfully!")
