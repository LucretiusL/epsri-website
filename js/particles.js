// ===== Particles System =====
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('particles-container');
if (container) {
    container.appendChild(canvas);
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
}

let particles = [];
let mouseX = 0, mouseY = 0;
let W = window.innerWidth, H = window.innerHeight;

function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
}
resize();
window.addEventListener('resize', resize);
window.addEventListener('mousemove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY + window.scrollY;
});

const colors = ['rgba(0,212,255,', 'rgba(123,47,255,', 'rgba(0,255,136,', 'rgba(255,107,53,'];

class Particle {
    constructor() { this.init(); }
    init() {
        this.x = Math.random() * W;
        this.y = Math.random() * H * 3;
        this.z = Math.random();
        this.size = 0.5 + this.z * 2;
        this.speedX = (Math.random() - 0.5) * 0.3;
        this.speedY = -0.1 - this.z * 0.3;
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.alpha = 0.2 + this.z * 0.5;
        this.life = 1;
        this.connected = [];
    }
    update() {
        this.x += this.speedX;
        this.y += this.speedY;
        if (this.y < -20 || this.x < -20 || this.x > W + 20) { this.init(); this.y = H * 3; }
    }
    draw() {
        const screenY = this.y - window.scrollY;
        if (screenY < -50 || screenY > H + 50) return;
        ctx.beginPath();
        ctx.arc(this.x, screenY, this.size, 0, Math.PI * 2);
        ctx.fillStyle = this.color + this.alpha + ')';
        ctx.fill();
    }
}

// Init particles
for (let i = 0; i < 120; i++) {
    const p = new Particle();
    p.y = Math.random() * H * 2;
    particles.push(p);
}

function connectParticles() {
    for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
            const pi = particles[i];
            const pj = particles[j];
            const dx = pi.x - pj.x;
            const dy = (pi.y - window.scrollY) - (pj.y - window.scrollY);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 100) {
                const alpha = (1 - dist / 100) * 0.15;
                ctx.beginPath();
                ctx.moveTo(pi.x, pi.y - window.scrollY);
                ctx.lineTo(pj.x, pj.y - window.scrollY);
                ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
        }
    }
}

function animate() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    connectParticles();
    requestAnimationFrame(animate);
}
animate();
