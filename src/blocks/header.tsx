import { m } from '@/paraglide/messages.js';
import { SiteHeader } from '@/components/site-header';

export function Header() {
  const navLinks = [
    { href: '/#courses', label: m['landing.nav.tracks']() },
    { href: '/blog', label: m['landing.nav.blog']() },
    { href: '/sign-in', label: m['landing.nav.sign_in']() },
  ];

  return <SiteHeader navLinks={navLinks} />;
}
