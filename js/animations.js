// ===== Molecule Animation for Research Page =====
function createMoleculeAnimation(svgId) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    // Animate bonds
    svg.querySelectorAll('.mol-bond').forEach((bond, i) => {
        bond.style.animationDelay = `${i * 0.5}s`;
    });
}

// ===== Typewriter effect =====
function typewriter(el, texts, speed = 80) {
    if (!el) return;
    let textIdx = 0;
    let charIdx = 0;
    let isDeleting = false;

    function type() {
        const text = texts[textIdx];
        if (isDeleting) {
            el.textContent = text.substring(0, charIdx - 1);
            charIdx--;
        } else {
            el.textContent = text.substring(0, charIdx + 1);
            charIdx++;
        }
        if (!isDeleting && charIdx === text.length) {
            setTimeout(() => { isDeleting = true; }, 2000);
        } else if (isDeleting && charIdx === 0) {
            isDeleting = false;
            textIdx = (textIdx + 1) % texts.length;
        }
        setTimeout(type, isDeleting ? speed / 2 : speed);
    }
    type();
}

// Init typewriter on hero if present
document.addEventListener('DOMContentLoaded', () => {
    const tw = document.querySelector('[data-typewriter]');
    if (tw) {
        const texts = tw.dataset.typewriter.split('|');
        typewriter(tw, texts);
    }
    createMoleculeAnimation('molecule-svg');
});

// ===== Hex hover ripple =====
document.querySelectorAll('.research-card').forEach(card => {
    card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const glow = card.querySelector('.card-glow');
        if (glow) {
            glow.style.background = `radial-gradient(circle at ${x}px ${y}px, rgba(0,212,255,0.12) 0%, transparent 60%)`;
        }
    });
});
