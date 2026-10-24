import Head from 'next/head';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://llb-accountant.vercel.app').replace(/\/$/, '');

export default function Landing() {
  const router = useRouter();
  const assetBasePath = router.basePath || '';
  const heroRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scrollY, setScrollY] = useState(0);

  // mouse parallax for 3D
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const handleMove = (e: MouseEvent) => {
      const rect = hero.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 12;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * -10;
      hero.style.setProperty('--mx', `${x}deg`);
      hero.style.setProperty('--my', `${y}deg`);
    };
    const handleLeave = () => {
      hero.style.setProperty('--mx', `0deg`);
      hero.style.setProperty('--my', `0deg`);
    };
    hero.addEventListener('mousemove', handleMove);
    hero.addEventListener('mouseleave', handleLeave);
    return () => {
      hero.removeEventListener('mousemove', handleMove);
      hero.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // live particle field
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let w = (canvas.width = canvas.offsetWidth * 2);
    let h = (canvas.height = canvas.offsetHeight * 2);
    const dpr = 2;
    const pts: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    const N = 42;
    for (let i = 0; i < N; i++) {
      pts.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.55,
        vy: (Math.random() - 0.5) * 0.45,
        r: Math.random() * 1.8 + 0.6,
      });
    }
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      // connections
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1 * dpr;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x;
          const dy = pts[i].y - pts[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < 220 * dpr) {
            ctx.globalAlpha = (1 - dist / (220 * dpr)) * 0.55;
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      // dots
      for (const p of pts) {
        p.x += p.vx * dpr;
        p.y += p.vy * dpr;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        // outer glow
        ctx.fillStyle = 'rgba(240,160,58,0.18)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
        // tiny orange core
        ctx.fillStyle = 'rgba(240,160,58,0.95)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.9 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => {
      w = canvas.width = canvas.offsetWidth * 2;
      h = canvas.height = canvas.offsetHeight * 2;
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#0b1e35', overflowX: 'hidden' }}>
      <Head>
        <title>Lope Laranjo Bato & Co., CPAs — Trusted Expertise. Lasting Value.</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Lope Laranjo Bato & Co., CPAs provides professional accounting, assurance, and advisory services with trusted expertise and lasting value." />
        <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
        <link rel="canonical" href={`${siteUrl}/landing`} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Lope Laranjo Bato & Co., CPAs" />
        <meta property="og:title" content="Lope Laranjo Bato & Co., CPAs — Trusted Expertise. Lasting Value." />
        <meta property="og:description" content="Professional accounting, assurance, and advisory services." />
        <meta property="og:url" content={`${siteUrl}/landing`} />
        <meta property="og:image" content={`${siteUrl}/logo.png`} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Lope Laranjo Bato & Co., CPAs" />
        <meta name="twitter:description" content="Professional accounting, assurance, and advisory services." />
        <meta name="twitter:image" content={`${siteUrl}/logo.png`} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'Lope Laranjo Bato & Co., CPAs',
              alternateName: 'LLB & Co., CPAs',
              url: `${siteUrl}/landing`,
              logo: `${siteUrl}/logo.png`,
              description: 'Professional accounting, assurance, and advisory services.',
            }),
          }}
        />
        <style>{`
          html { scroll-behavior: smooth; }
          body { margin:0; background:#0b1e35; }
          @keyframes floatY { 0%,100%{ transform: translateY(0) rotateX(var(--my,0)) rotateY(var(--mx,0)); } 50%{ transform: translateY(-10px) rotateX(var(--my,0)) rotateY(var(--mx,0)); } }
          @keyframes gradientShift { 0%{ filter: hue-rotate(0deg) brightness(1); } 50%{ filter: hue-rotate(6deg) brightness(1.08); } 100%{ filter: hue-rotate(0deg) brightness(1); } }
          @keyframes shimmer { 0%{ transform: translateX(-100%); } 100%{ transform: translateX(200%); } }
          @keyframes lineDraw { from{ stroke-dashoffset: 1200; } to{ stroke-dashoffset: 0; } }
          @keyframes orbit { from{ transform: rotate(0deg) translateX(42px) rotate(0deg); } to{ transform: rotate(360deg) translateX(42px) rotate(-360deg); } }
          @keyframes pulseGlow { 0%,100%{ box-shadow: 0 0 0 0 rgba(240,160,58,0.0); } 50%{ box-shadow: 0 0 0 12px rgba(240,160,58,0.08); } }
        `}</style>
      </Head>

      {/* NAV */}
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          height: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: scrollY > 18 ? 'rgba(10, 28, 52, 0.72)' : 'rgba(10, 28, 52, 0.18)',
          backdropFilter: scrollY > 18 ? 'blur(14px) saturate(1.4)' : 'blur(6px)',
          WebkitBackdropFilter: scrollY > 18 ? 'blur(14px) saturate(1.4)' : 'blur(6px)',
          borderBottom: scrollY > 18 ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.06)',
          transition: 'all 0.3s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.10)',
              display: 'grid',
              placeItems: 'center',
              overflow: 'hidden',
              boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
            }}
          >
            <Image src={`${assetBasePath}/logo-ui.webp`} alt="LLB" width={30} height={30} unoptimized style={{ objectFit: 'contain' }} />
          </div>
          <div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 13, fontWeight: 800, color: '#f8f9fa', letterSpacing: 0.3, lineHeight: 1 }}>Lope Laranjo Bato & Co.</div>
            <div style={{ fontSize: 9, letterSpacing: 2.2, color: '#f0a03a', fontWeight: 700, marginTop: 1 }}>CPAs • ACCOUNTING • ASSURANCE • ADVISORY</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="#services" style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)', textDecoration: 'none', fontWeight: 600, letterSpacing: 0.4, display: 'none' }}>
            Services
          </a>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 38,
              padding: '0 18px',
              borderRadius: 999,
              background: 'linear-gradient(135deg, #3aa0e6 0%, #1e6aa8 55%, #174a82 100%)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 1.2,
              textDecoration: 'none',
              border: '1px solid rgba(255,255,255,0.88)',
              boxShadow: '0 8px 22px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.22)',
              transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
          >
            LOG IN
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </nav>

      {/* HERO — cinematic 3D */}
      <div
        ref={heroRef}
        style={
          {
            position: 'relative',
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            padding: '84px 24px 40px',
            background: 'radial-gradient(circle at 18% 22%, rgba(255,255,255,0.08), transparent 42%), radial-gradient(circle at 85% 85%, rgba(13,51,92,0.34), transparent 44%), linear-gradient(135deg, #0f2a4a 0%, #174a82 45%, #2166a5 72%, #2e7eb8 100%)',
            animation: 'gradientShift 14s ease-in-out infinite',
            '--mx': '0deg',
            '--my': '0deg',
          } as React.CSSProperties
        }
      >
        {/* video backdrop */}
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={`${assetBasePath}/login-background.png`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.10, mixBlendMode: 'screen' }}
        >
          <source src={`${assetBasePath}/login-bg.mp4`} type="video/mp4" />
        </video>

        {/* analytics SVG — cinematic */}
        <svg
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.72 }}
        >
          <defs>
            <linearGradient id="heroGold" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.12" />
              <stop offset="48%" stopColor="#fff" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#f0a03a" stopOpacity="0.62" />
            </linearGradient>
            <linearGradient id="heroBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d="M-40 780 C 220 710, 420 820, 680 740 S 1080 630, 1480 680" stroke="url(#heroGold)" strokeWidth="1.1" fill="none" />
          <path d="M-40 720 C 200 650, 460 760, 720 680 S 1120 560, 1480 615" stroke="url(#heroGold)" strokeWidth="1" fill="none" opacity="0.7" />
          <polyline
            points="60,660 170,620 265,638 380,540 470,565 590,450 700,475 820,340 930,385 1040,275 1160,320 1290,205 1400,245"
            fill="none"
            stroke="url(#heroGold)"
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="1200"
            strokeDashoffset="1200"
            style={{ animation: 'lineDraw 2.6s ease-out 0.5s forwards' }}
          />
          {[60, 170, 265, 380, 470, 590, 700, 820, 930, 1040, 1160, 1290, 1400].map((x, i) => {
            const y = [660, 620, 638, 540, 565, 450, 475, 340, 385, 275, 320, 205, 245][i];
            return (
              <g key={x}>
                <circle cx={x} cy={y} r="7" fill="#fff" opacity="0.13" />
                <circle cx={x} cy={y} r="3" fill="#f0a03a" opacity="0.95" />
              </g>
            );
          })}
          {[120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1140, 1200].map((x, i) => {
            const h = 40 + ((i * 37) % 120);
            return <rect key={x} x={x} y={900 - h - 70} width="26" height={h} rx="3" fill="url(#heroBar)" opacity="0.9" />;
          })}
        </svg>

        {/* particle canvas */}
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.65 }} />

        {/* orbs */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            width: 520,
            height: 520,
            left: -80,
            top: -60,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,255,255,0.07), transparent 70%)',
            filter: 'blur(12px)',
            pointerEvents: 'none',
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute',
            width: 560,
            height: 560,
            right: -90,
            bottom: -90,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(240,160,58,0.10), transparent 72%)',
            filter: 'blur(16px)',
            pointerEvents: 'none',
          }}
        />

        {/* content */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            width: 'min(1180px, 100%)',
            display: 'grid',
            gridTemplateColumns: '1.05fr 0.95fr',
            gap: 28,
            alignItems: 'center',
          }}
        >
          {/* left copy */}
          <div style={{ textAlign: 'left', padding: '18px 0' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1.6,
                backdropFilter: 'blur(10px)',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: '#22c55e', boxShadow: '0 0 0 6px rgba(34,197,94,0.14)', display: 'inline-block' }} />
              LIVE SYSTEM • SECURE • AUDIT-READY
            </div>

            <h1
              style={{
                margin: '14px 0 10px',
                fontFamily: 'Georgia, serif',
                fontSize: 'clamp(30px, 4.2vw, 48px)',
                lineHeight: 0.98,
                fontWeight: 800,
                color: '#fff',
                textShadow: '0 8px 32px rgba(0,0,0,0.28)',
                letterSpacing: 0.2,
              }}
            >
              Lope Laranjo
              <br />
              Bato & Co.,{' '}
              <span style={{ background: 'linear-gradient(90deg, #fff 30%, #f0a03a 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>CPAs</span>
            </h1>

            <div style={{ fontSize: 12, letterSpacing: 5, color: '#f0a03a', fontWeight: 800, marginBottom: 14 }}>ACCOUNTING. ASSURANCE. ADVISORY.</div>
            <p style={{ maxWidth: 520, fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.88)', margin: '0 0 18px' }}>
              Trusted Expertise. Lasting Value. A cinematic, 3D-ready client portal for payroll, attendance, projects, and governance — built on the same blue & orange system you log into every day.
            </p>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Link
                href="/"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 46,
                  padding: '0 22px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #3aa0e6 0%, #1e6aa8 55%, #174a82 100%)',
                  color: '#fff',
                  fontWeight: 900,
                  letterSpacing: 1.2,
                  fontSize: 13,
                  textDecoration: 'none',
                  border: '1px solid rgba(255,255,255,0.88)',
                  boxShadow: '0 10px 28px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.22)',
                }}
              >
                ENTER PORTAL — LOG IN
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
              <a
                href="#services"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 46,
                  padding: '0 18px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e2e8f0',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                  border: '1.5px solid rgba(240,160,58,0.45)',
                  backdropFilter: 'blur(10px)',
                }}
              >
                Explore Services
              </a>
            </div>

            <div style={{ display: 'flex', gap: 18, marginTop: 22, flexWrap: 'wrap' }}>
              {[
                { k: 'TRUSTED', v: 'ADVISORS', icon: 'M12 2l7 3v6c0 5-3.5 9.5-7 11-3.5-1.5-7-6-7-11V5l7-3z' },
                { k: 'DATA DRIVEN', v: 'INSIGHTS', icon: 'M3 20h18 M4 20V10 M8 20V6 M12 20v-8 M16 20V8 M20 20V4' },
                { k: 'COMMITMENT TO', v: 'EXCELLENCE', icon: 'M12 2l2.5 4.5 5 .7-3.6 3.4.9 5-4.8-2.5-4.8 2.5.9-5L4.5 7.2l5-.7L12 2z' },
              ].map((f) => (
                <div key={f.k} style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#e5e7eb' }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f0a03a" strokeWidth="1.9">
                    <path d={f.icon} />
                  </svg>
                  <span style={{ fontSize: 9, letterSpacing: 1.6, lineHeight: 1.3, fontWeight: 700 }}>
                    {f.k}
                    <br />
                    {f.v}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* right 3D */}
          <div style={{ perspective: 1200, display: 'grid', placeItems: 'center', minHeight: 420 }}>
            <div
              style={{
                position: 'relative',
                width: 'min(420px, 92vw)',
                height: 380,
                transformStyle: 'preserve-3d',
                transform: 'rotateX(var(--my,0)) rotateY(var(--mx,0))',
                animation: 'floatY 6s ease-in-out infinite',
                willChange: 'transform',
              }}
            >
              {/* glow */}
              <div
                style={{
                  position: 'absolute',
                  inset: -22,
                  borderRadius: 28,
                  background: 'radial-gradient(circle at 50% 20%, rgba(255,255,255,0.10), transparent 60%), radial-gradient(circle at 78% 88%, rgba(240,160,58,0.16), transparent 58%)',
                  filter: 'blur(10px)',
                }}
              />

              {/* glass card */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 24,
                  background: 'rgba(255,255,255,0.07)',
                  border: '1.8px solid rgba(240,160,58,0.32)',
                  backdropFilter: 'blur(18px) saturate(1.3)',
                  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
                  boxShadow: '0 22px 50px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.16)',
                  overflow: 'hidden',
                  transform: 'translateZ(24px)',
                }}
              >
                {/* top bar */}
                <div style={{ height: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: '#ef4444' }} />
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: '#f59e0b' }} />
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: '#22c55e' }} />
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: 'rgba(255,255,255,0.72)' }}>LLB • LIVE PORTAL</div>
                  <div style={{ width: 28, height: 18, borderRadius: 999, background: 'rgba(240,160,58,0.14)', border: '1px solid rgba(240,160,58,0.28)', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 800, color: '#f0a03a' }}>● LIVE</div>
                </div>

                {/* 3D LB */}
                <div style={{ position: 'relative', height: 210, display: 'grid', placeItems: 'center', perspective: 800, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,0.06), transparent 62%)' }} />
                  {/* stacked LB */}
                  <div style={{ position: 'relative', transformStyle: 'preserve-3d', transform: 'rotateX(8deg) rotateY(-14deg)', display: 'flex', alignItems: 'center', gap: 0 }}>
                    <div
                      style={{
                        fontFamily: 'Georgia, serif',
                        fontSize: 108,
                        fontWeight: 900,
                        color: '#fff',
                        letterSpacing: -8,
                        textShadow: '0 1px 0 #e2e8f0, 0 6px 0 #cbd5e1, 0 12px 18px rgba(0,0,0,0.28), 0 22px 28px rgba(0,0,0,0.22)',
                        transform: 'translateZ(18px)',
                      }}
                    >
                      <span style={{ display: 'inline-block', transform: 'translateZ(6px)' }}>L</span>
                      <span style={{ display: 'inline-block', transform: 'translateZ(22px)', marginLeft: -6 }}>B</span>
                    </div>
                    {/* orange arrow 3D */}
                    <div
                      style={{
                        position: 'absolute',
                        left: -18,
                        right: -26,
                        top: '52%',
                        height: 18,
                        background: 'linear-gradient(90deg, rgba(240,160,58,0.0) 0%, rgba(240,160,58,0.95) 38%, #f0a03a 100%)',
                        transform: 'rotate( -18deg) translateZ(32px)',
                        boxShadow: '0 8px 18px rgba(240,160,58,0.28)',
                        borderRadius: 2,
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          right: -14,
                          top: '50%',
                          width: 0,
                          height: 0,
                          borderLeft: '18px solid #f0a03a',
                          borderTop: '11px solid transparent',
                          borderBottom: '11px solid transparent',
                          transform: 'translateY(-50%)',
                          filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.22))',
                        }}
                      />
                    </div>
                  </div>
                  {/* orbiting dot */}
                  <div style={{ position: 'absolute', width: 86, height: 86, borderRadius: '50%', border: '1px dashed rgba(255,255,255,0.14)', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>
                    <div style={{ position: 'absolute', width: 10, height: 10, borderRadius: 999, background: '#f0a03a', top: 0, left: '50%', marginLeft: -5, boxShadow: '0 0 0 8px rgba(240,160,58,0.12)', animation: 'orbit 3.8s linear infinite' }} />
                  </div>
                  <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', fontSize: 9, letterSpacing: 2.4, color: 'rgba(255,255,255,0.72)', fontWeight: 800, background: 'rgba(0,0,0,0.14)', border: '1px solid rgba(255,255,255,0.08)', padding: '4px 8px', borderRadius: 999, backdropFilter: 'blur(8px)' }}>
                    CERTIFIED PUBLIC ACCOUNTANTS
                  </div>
                </div>

                {/* mini stats */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, padding: 12, background: 'rgba(255,255,255,0.04)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {[
                    { label: 'PAYROLL', value: '99.9%', sub: 'accuracy' },
                    { label: 'UPTIME', value: '24/7', sub: 'secure' },
                    { label: 'CLIENTS', value: '500+', sub: 'trusted' },
                  ].map((s) => (
                    <div key={s.label} style={{ borderRadius: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', padding: '10px 8px', textAlign: 'center', backdropFilter: 'blur(8px)' }}>
                      <div style={{ fontSize: 9, letterSpacing: 1.2, color: '#f0a03a', fontWeight: 800 }}>{s.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 900, color: '#fff', marginTop: 2 }}>{s.value}</div>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.62)' }}>{s.sub}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* floating badge */}
              <div
                style={{
                  position: 'absolute',
                  right: -8,
                  top: 24,
                  padding: '8px 10px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.92)',
                  border: '1px solid rgba(240,160,58,0.22)',
                  boxShadow: '0 14px 28px rgba(0,0,0,0.22)',
                  transform: 'translateZ(48px)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  animation: 'pulseGlow 2.8s ease-in-out infinite',
                }}
              >
                <span style={{ width: 26, height: 26, borderRadius: 999, background: '#22c55e', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, fontSize: 12 }}>✓</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 900, color: '#0f172a', lineHeight: 1 }}>Audit Ready</div>
                  <div style={{ fontSize: 9, color: '#64748b' }}>Real-time ledger</div>
                </div>
              </div>

              {/* bottom glass */}
              <div
                style={{
                  position: 'absolute',
                  left: 18,
                  right: 18,
                  bottom: -14,
                  height: 42,
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  backdropFilter: 'blur(12px)',
                  transform: 'translateZ(12px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-around',
                  color: 'rgba(255,255,255,0.86)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.8,
                }}
              >
                <span>⚡ Payroll</span>
                <span style={{ opacity: 0.35 }}>|</span>
                <span>🛡️ Assurance</span>
                <span style={{ opacity: 0.35 }}>|</span>
                <span>📊 Advisory</span>
              </div>
            </div>
          </div>
        </div>

        {/* scroll indicator */}
        <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: 0.72 }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: 'rgba(255,255,255,0.66)', fontWeight: 800 }}>SCROLL</div>
          <div style={{ width: 22, height: 34, borderRadius: 999, border: '1.5px solid rgba(255,255,255,0.22)', display: 'grid', placeItems: 'center', paddingTop: 4 }}>
            <div style={{ width: 3, height: 8, borderRadius: 999, background: '#f0a03a', animation: 'floatY 1.6s ease-in-out infinite' }} />
          </div>
        </div>
      </div>

      {/* SERVICES */}
      <section id="services" style={{ position: 'relative', padding: '56px 24px', background: 'linear-gradient(180deg, #0b1e35 0%, #0e2a4a 100%)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ display: 'inline-flex', padding: '6px 10px', borderRadius: 999, background: 'rgba(240,160,58,0.10)', border: '1px solid rgba(240,160,58,0.22)', color: '#f0a03a', fontSize: 10, fontWeight: 800, letterSpacing: 1.4 }}>WHAT WE DO</div>
            <h2 style={{ margin: '12px 0 8px', fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 800, color: '#fff' }}>Accounting. Assurance. Advisory.</h2>
            <p style={{ margin: 0, color: 'rgba(255,255,255,0.72)', fontSize: 13, maxWidth: 640, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
              A cinematic system for modern firms — payroll automation, project governance, attendance intelligence, and audit-grade reporting, all in your brand blue & orange.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            {[
              {
                title: 'Accounting',
                desc: 'Ledger, payroll, deductions, and compliance — real-time, accurate, and audit-ready.',
                icon: 'M12 2l7 3v6c0 5-3.5 9.5-7 11-3.5-1.5-7-6-7-11V5l7-3z',
                accent: '#f0a03a',
              },
              {
                title: 'Assurance',
                desc: 'Risk-aware workflows, approvals, and evidence trails with live status and controls.',
                icon: 'M9 12l2 2 4-5 M3 20h18 M4 20V10 M8 20V6 M12 20v-8 M16 20V8 M20 20V4',
                accent: '#3aa0e6',
              },
              {
                title: 'Advisory',
                desc: 'Data-driven insights and cinematic dashboards that turn numbers into strategy.',
                icon: 'M12 2l2.5 4.5 5 .7-3.6 3.4.9 5-4.8-2.5-4.8 2.5.9-5L4.5 7.2l5-.7L12 2z',
                accent: '#22c55e',
              },
            ].map((card) => (
              <div
                key={card.title}
                style={{
                  position: 'relative',
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  backdropFilter: 'blur(12px)',
                  padding: 18,
                  overflow: 'hidden',
                  transformStyle: 'preserve-3d',
                  transition: 'transform 0.25s ease, border-color 0.25s ease',
                }}
                onMouseMove={(e) => {
                  const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  const x = ((e.clientX - r.left) / r.width - 0.5) * 8;
                  const y = ((e.clientY - r.top) / r.height - 0.5) * -6;
                  (e.currentTarget as HTMLDivElement).style.transform = `perspective(900px) rotateY(${x}deg) rotateX(${y}deg) translateZ(6px)`;
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(240,160,58,0.22)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform = 'perspective(900px) rotateY(0) rotateX(0)';
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.08)';
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent, ${card.accent}55, transparent)`, opacity: 0.9 }} />
                <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${card.accent}22, rgba(255,255,255,0.04))`, border: `1px solid ${card.accent}30`, display: 'grid', placeItems: 'center', marginBottom: 12 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={card.accent} strokeWidth="1.9">
                    <path d={card.icon} />
                  </svg>
                </div>
                <div style={{ fontSize: 15, fontWeight: 900, color: '#fff', marginBottom: 6 }}>{card.title}</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.70)' }}>{card.desc}</div>
                <div style={{ marginTop: 14, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['Live', 'Secure', '3D Ready'].map((t) => (
                    <span key={t} style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.8, color: 'rgba(255,255,255,0.72)', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', padding: '4px 7px', borderRadius: 999 }}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* live dashboard strip */}
          <div
            style={{
              marginTop: 22,
              borderRadius: 16,
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'grid',
              gridTemplateColumns: '1.1fr 0.9fr',
              minHeight: 220,
            }}
          >
            <div style={{ padding: 18, display: 'grid', alignContent: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: '#f0a03a' }}>LIVE PORTAL PREVIEW</div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 20, fontWeight: 800, color: '#fff', lineHeight: 1.1 }}>Your firm, live & cinematic</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.70)' }}>
                The same blue you see at log in — now as a full 3D workspace. Glass cards, orange accents, and real-time analytics that feel alive.
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: '#fff', color: '#0f2a4a', fontWeight: 900, fontSize: 12, textDecoration: 'none', border: '1px solid rgba(240,160,58,0.18)' }}>
                  Go to Log In →
                </Link>
                <span style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 12px', borderRadius: 10, background: 'rgba(240,160,58,0.14)', border: '1px solid rgba(240,160,58,0.28)', color: '#f0a03a', fontWeight: 800, fontSize: 11 }}>● System Live</span>
              </div>
            </div>
            <div style={{ position: 'relative', background: 'linear-gradient(135deg, #0f2a4a 0%, #174a82 60%, #1e6aa8 100%)', overflow: 'hidden', display: 'grid', placeItems: 'center', padding: 14 }}>
              <svg viewBox="0 0 320 180" style={{ width: '100%', height: 'auto', maxWidth: 360 }}>
                <rect x="10" y="10" width="300" height="160" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" />
                <rect x="20" y="22" width="80" height="8" rx="4" fill="rgba(240,160,58,0.92)" />
                <rect x="20" y="36" width="48" height="4" rx="2" fill="rgba(255,255,255,0.52)" />
                <g opacity="0.9">
                  {[20, 52, 84, 116, 148, 180, 212, 244].map((x, i) => {
                    const h = 18 + ((i * 19) % 48);
                    return <rect key={x} x={x} y={120 - h} width="22" height={h} rx="3" fill={i % 2 === 0 ? 'rgba(255,255,255,0.92)' : 'rgba(240,160,58,0.92)'} />;
                  })}
                </g>
                <polyline points="20,86 52,78 84,88 116,62 148,70 180,44 212,52 244,32 276,38" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" opacity="0.9" />
                <circle cx="276" cy="38" r="3" fill="#f0a03a" />
              </svg>
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%)', transform: 'translateX(-100%)', animation: 'shimmer 2.8s ease-in-out infinite' }} />
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ padding: '22px 24px', background: '#07162b', borderTop: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: 'Georgia, serif', fontWeight: 800, color: '#fff', fontSize: 12 }}>Lope Laranjo Bato & Co., CPAs</div>
            <div style={{ marginTop: 2 }}>© {new Date().getFullYear()} Trusted Expertise. Lasting Value. • Built in system blue #2166a5 & orange #f0a03a</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ padding: '6px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>Accounting • Assurance • Advisory</span>
            <Link href="/" style={{ padding: '8px 14px', borderRadius: 999, background: 'rgba(240,160,58,0.14)', border: '1px solid rgba(240,160,58,0.28)', color: '#f0a03a', fontWeight: 800, textDecoration: 'none', fontSize: 11 }}>
              Log In
            </Link>
          </div>
        </div>
      </footer>

      <style>{`
        @media (max-width: 880px){
          nav{ padding: 0 14px !important; }
          div[style*="gridTemplateColumns: 1.05fr 0.95fr"]{ grid-template-columns: 1fr !important; }
          div[style*="gridTemplateColumns: repeat(3, 1fr)"]{ grid-template-columns: 1fr !important; }
          div[style*="gridTemplateColumns: 1.1fr 0.9fr"]{ grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
