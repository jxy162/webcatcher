// A deliberately animation-heavy script served to the test page.
const targets = document.querySelectorAll('.card');
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => entry.target.classList.toggle('active', entry.isIntersecting));
}, { threshold: 0.2 });
targets.forEach((target) => observer.observe(target));
function springyMove(element) {
  element.animate(
    [{ transform: 'translateX(0px)' }, { transform: 'translateX(24px)' }, { transform: 'translateX(0px)' }],
    { duration: 540, easing: 'cubic-bezier(.2,.9,.2,1.2)' }
  );
}
window.springyMove = springyMove;
