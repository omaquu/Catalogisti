// Texture preview: the texture set on a rotating sphere (or a flat tile), lit like a material ball.
// The height map displaces the surface, so relief and parallax can be judged; the normal map adds fine detail.
import * as THREE from "./vendor/three.module.min.js";

function mount(container, maps, { depth = 0.035, shape = "sphere", tiles = 2 } = {}) {
  const width = () => container.clientWidth || 300;
  const height = () => container.clientHeight || 300;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width(), height());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.replaceChildren(renderer.domElement);
  renderer.domElement.style.cursor = "grab";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, width() / height(), 0.1, 50);
  camera.position.set(0, 0, 4.2);
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x302820, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 2.5, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 0.8);
  rim.position.set(-3, -1, -2);
  scene.add(rim);

  const loader = new THREE.TextureLoader();
  const load = (url, color) => {
    if (!url) return null;
    const t = loader.load(url, () => render());
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(shape === "sphere" ? tiles * 2 : tiles, tiles);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  mat.map = load(maps.albedo, true);
  mat.normalMap = load(maps.normal);
  if (maps.orm) {
    // Godot ORM order matches three.js: R = occlusion, G = roughness, B = metallic.
    const orm = load(maps.orm);
    mat.aoMap = orm; mat.roughnessMap = orm; mat.metalnessMap = orm; mat.metalness = 1; mat.roughness = 1;
  } else {
    if (maps.roughness) { mat.roughnessMap = load(maps.roughness); mat.roughness = 1; }
    if (maps.metallic) { mat.metalnessMap = load(maps.metallic); mat.metalness = 1; }
    if (maps.ao) mat.aoMap = load(maps.ao);
  }
  if (maps.height) { mat.displacementMap = load(maps.height); mat.displacementScale = depth; mat.displacementBias = -depth / 2; }

  const geometry = shape === "sphere" ? new THREE.SphereGeometry(1, 384, 192) : new THREE.PlaneGeometry(2.4, 2.4, 384, 384);
  const mesh = new THREE.Mesh(geometry, mat);
  scene.add(mesh);
  if (shape !== "sphere") mesh.rotation.x = -0.35;

  // Drag to rotate, wheel to zoom; idles into a slow spin.
  let dragging = false, lastX = 0, lastY = 0, spin = 0.25, raf = 0, idleAt = 0;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    mesh.rotation.y += (e.clientX - lastX) * 0.01;
    mesh.rotation.x = Math.max(-1.4, Math.min(1.4, mesh.rotation.x + (e.clientY - lastY) * 0.01));
    lastX = e.clientX; lastY = e.clientY; render();
  });
  el.addEventListener("pointerup", () => { dragging = false; idleAt = performance.now(); el.style.cursor = "grab"; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); camera.position.z = Math.max(1.8, Math.min(9, camera.position.z * (1 + Math.sign(e.deltaY) * 0.08))); render(); }, { passive: false });

  function render() { renderer.render(scene, camera); }
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!dragging && now - idleAt > 1500) mesh.rotation.y += spin * dt;
    render();
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  const ro = new ResizeObserver(() => { renderer.setSize(width(), height()); camera.aspect = width() / height(); camera.updateProjectionMatrix(); render(); });
  ro.observe(container);

  return {
    setDepth(d) { if (mat.displacementMap) { mat.displacementScale = d; mat.displacementBias = -d / 2; } },
    hasHeight: !!maps.height,
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      geometry.dispose();
      for (const t of new Set([mat.map, mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.aoMap, mat.displacementMap])) t?.dispose();
      mat.dispose(); renderer.dispose(); renderer.forceContextLoss?.();
      el.remove();
    },
  };
}

window.CatalogistiSphere = { mount };
