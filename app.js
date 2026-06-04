// ============================================================
//  VISUALISEUR 3D HYBRIDE — BabylonJS
//  GLB (meshopt + KTX2) + Gaussian Splatting (.sog) + NavMesh
// ============================================================

const canvas  = document.getElementById("renderCanvas");
const engine  = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    antialias: true
});

const loadingScreen = document.getElementById("loading-screen");
const loadingText   = document.getElementById("loading-text");
const loadingBar    = document.getElementById("loading-bar");
const hint          = document.getElementById("hint");
const crosshair     = document.getElementById("crosshair");


// ─────────────────────────────────────────────────────────
// PLUGIN SHADER : Optimisation de la densité des Splats
// ─────────────────────────────────────────────────────────
class SplatDensityPlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
        // On enregistre le plugin sous le nom "SplatDensity"
        super(material, "SplatDensity", 100, { "SPLAT_DENSITY": true });
    }

    // On injecte notre logique mathématique au début du Fragment Shader
    getCustomCode(shaderType) {
        if (shaderType === "fragment") {
            return {
                "CUSTOM_FRAGMENT_MAIN_BEGIN": `
                    // 1. Calcul de la distance linéaire entre la caméra et le pixel (splat)
                    float distanceToCam = 1.0 / gl_FragCoord.w;

                    // 2. Génération d'un bruit pseudo-aléatoire entre 0.0 et 1.0 propre à chaque pixel
                    float pseudoRandom = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

                    // 3. Application de tes paliers de distance :
                    if (distanceToCam > 30.0) {
                        // Au-delà de 30m : on ne garde que 30% des splats (on rejette les 70% restants)
                        if (pseudoRandom > 0.30) discard;
                    } 
                    else if (distanceToCam > 10.0) {
                        // Entre 10m et 30m : on garde 70% des splats (on rejette 30%)
                        if (pseudoRandom > 0.70) discard;
                    }
                    // De 0 à 10m : le code continue normalement, affichage à 100%
                `
            };
        }
        return null;
    }
}

// ─────────────────────────────────────────
// HELPERS chargement
// ─────────────────────────────────────────
function setProgress(pct, msg) {
    if (msg) loadingText.innerText = msg;
    loadingBar.style.width = pct + "%";
}

function hideLoading() {
    setProgress(100, "Prêt !");
    setTimeout(() => {
        loadingScreen.classList.add("hidden");
        setTimeout(() => loadingScreen.style.display = "none", 700);
    }, 350);
}

// ─────────────────────────────────────────
// 1. DÉCODEURS GÉOMÉTRIQUES
// ─────────────────────────────────────────
async function initDecoders() {
    setProgress(5, "Configuration des décodeurs géométriques…");

    if (typeof MeshoptDecoder !== "undefined") {
        await MeshoptDecoder.ready;
        if (BABYLON.GLTF2?.Loader?.Extensions?.EXT_meshopt_compression) {
            BABYLON.GLTF2.Loader.Extensions.EXT_meshopt_compression.Decoder = MeshoptDecoder;
        }
    }

    BABYLON.KhronosTextureContainer2.URLConfig = {
        jsDecoderModule:      "https://cdn.babylonjs.com/babylon.ktx2Decoder.js",
        wasmUASTCToASTC:      "https://cdn.babylonjs.com/ktx2Transcoders/1/uastc_astc.wasm",
        wasmUASTCToBC7:       "https://cdn.babylonjs.com/ktx2Transcoders/1/uastc_bc7.wasm",
        wasmUASTCToRGBA_UNORM:"https://cdn.babylonjs.com/ktx2Transcoders/1/uastc_rgba32_unorm.wasm",
        wasmUASTCToRGBA_SRGB: "https://cdn.babylonjs.com/ktx2Transcoders/1/uastc_rgba32_srgb.wasm",
        wasmMSCTranscoder:    "https://cdn.babylonjs.com/ktx2Transcoders/1/msc_basis_transcoder.wasm",
        jsMSCTranscoder:      "https://cdn.babylonjs.com/ktx2Transcoders/1/msc_basis_transcoder.js",
        wasmZSTDDecoder:      "https://cdn.babylonjs.com/zstddec.wasm"
    };
}

// ─────────────────────────────────────────
// 2. INIT RECAST
// ─────────────────────────────────────────
async function initRecast() {
    return new Promise((resolve, reject) => {
        if (typeof Recast === "undefined") {
            console.warn("Recast non disponible — navigation désactivée");
            return resolve(null);
        }
        try {
            const instance = Recast();
            if (instance && typeof instance.then === "function") {
                instance.then((mod) => {
                    console.log("Recast initialisé (Promise)");
                    resolve(mod);
                }).catch(reject);
            } else {
                console.log("Recast déjà initialisé");
                resolve(instance || Recast);
            }
        } catch (e) {
            console.warn("Erreur init Recast:", e);
            resolve(null);
        }
    });
}

// ─────────────────────────────────────────
// 3. LOADER GAUSSIAN SPLATTING
// ─────────────────────────────────────────
async function loadGaussianSplatting(scene, url, name) {
    try {
        const result = await BABYLON.SceneLoader.ImportMeshAsync("", "", url, scene);
        if (result.meshes.length > 0) {
            console.log(`[SOG] ${name} chargé via SceneLoader`);
            return result.meshes[0];
        }
    } catch (e1) {
        console.warn(`[SOG] SceneLoader échoué pour ${name}:`, e1.message);
    }

    try {
        if (typeof BABYLON.GaussianSplattingMesh !== "undefined") {
            const gs = new BABYLON.GaussianSplattingMesh(name, url, scene);
            await gs.loadFileAsync(url);
            console.log(`[SOG] ${name} chargé via GaussianSplattingMesh`);
            return gs;
        }
    } catch (e2) {
        console.warn(`[SOG] GaussianSplattingMesh échoué pour ${name}:`, e2.message);
    }

    console.error(`[SOG] Impossible de charger ${name}`);
    return null;
}

// ─────────────────────────────────────────
// 4. SCÈNE PRINCIPALE
// ─────────────────────────────────────────
const createScene = async function () {
    await initDecoders();
    const recastInstance = await initRecast();

    let navigationPlugin = null;
    if (recastInstance) {
        try {
            navigationPlugin = new BABYLON.RecastJSPlugin(recastInstance);
        } catch(e) {
            console.warn("RecastJSPlugin échoué:", e);
        }
    }

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.03, 0.03, 0.05, 1);

    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.8;
    const dirLight = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-1, -2, -1), scene);
    dirLight.intensity = 0.4;

    // ─────────────────────────────────────
    // CAMÉRAS
    // ─────────────────────────────────────
    const droneCam = new BABYLON.ArcRotateCamera("droneCam",
        -Math.PI / 2, Math.PI / 3.5, 60,
        new BABYLON.Vector3(0, 5, 0), scene);
    droneCam.panningSensibility = 80;
    droneCam.wheelPrecision     = 3;
    droneCam.minZ = 0.1;
    droneCam.maxZ = 3000;
    droneCam.lowerRadiusLimit = 5;
    droneCam.attachControl(canvas, true);

    const groundCam = new BABYLON.UniversalCamera("groundCam",
        new BABYLON.Vector3(0, 0.8, 0), scene);
    groundCam.minZ = 0.05;
    groundCam.maxZ = 500;
    groundCam.speed = 0;
    groundCam.keysUp    = [90, 38];
    groundCam.keysDown  = [83, 40];
    groundCam.keysLeft  = [81, 37];
    groundCam.keysRight = [68, 39];
    
    // 1. On supprime le contrôle tactile par défaut (qui bloque la vue verticale)
    groundCam.inputs.removeByType("FreeCameraTouchInput");

    // 2. Ajustement de la vitesse de rotation selon l'appareil au démarrage
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        groundCam.angularSensibility = 1500; 
    } else {
        groundCam.angularSensibility = 3000; 
    }

    // ─────────────────────────────────────
    // ÉTAT GLOBAL
    // ─────────────────────────────────────
    let mainMesh        = null;
    let collisionMesh   = null;
    let droneSplatting  = null;
    let groundSplatting = null;
    let isNavMeshReady  = false;
    let currentWalkAnim = null;
    let currentMode     = "drone";
    let walkTarget      = null;

    // ─────────────────────────────────────
    // CHARGEMENT ASSETS
    // ─────────────────────────────────────

    // A. Scène principale GLB
    setProgress(10, "Téléchargement de la scène 3D…");
    try {
        const meshResult = await BABYLON.SceneLoader.ImportMeshAsync(
            "", "./assets/", "scene_optimisee2.glb", scene,
            (evt) => {
                if (evt.lengthComputable) {
                    const p = 10 + Math.floor((evt.loaded / evt.total) * 40);
                    setProgress(p, `Scène 3D : ${Math.floor((evt.loaded/evt.total)*100)}%`);
                }
            }
        );
        mainMesh = meshResult.meshes[0];
        if (mainMesh) {
            console.log("Scène GLB chargée :", meshResult.meshes.length, "meshes");
        }
    } catch (e) {
        console.error("Erreur chargement GLB principal :", e);
    }

    // B. Mesh de collision + génération NavMesh
    setProgress(55, "Génération du maillage de navigation…");
    try {
        const colResult = await BABYLON.SceneLoader.ImportMeshAsync(
            "", "./assets/", "collision_mesh.glb", scene);

        collisionMesh = colResult.meshes.find(m => m.getTotalVertices() > 0) || colResult.meshes[0];

        if (collisionMesh) {
            collisionMesh.visibility      = 0;
            collisionMesh.isPickable      = true;
            collisionMesh.checkCollisions = false;

            if (navigationPlugin) {
                const navParams = {
                    cs: 0.2,
                    ch: 0.15,
                    walkableSlopeAngle:     90,
                    walkableHeight:         2.0,
                    walkableClimb:          1.0,
                    walkableRadius:         0.3,
                    maxEdgeLen:             12,
                    maxSimplificationError: 1.3,
                    minRegionArea:          4,
                    mergeRegionArea:        20,
                    maxVertsPerPoly:        6,
                    detailSampleDist:       6,
                    detailSampleMaxError:   1
                };
                navigationPlugin.createNavMesh([collisionMesh], navParams);
                isNavMeshReady = true;
                console.log("NavMesh généré avec succès !");
            }
        }
    } catch (e) {
        console.error("Mesh collision introuvable :", e);
    }

    // C. Gaussian Splatting — Vue Drone
    setProgress(65, "Chargement du nuage drone…");
    droneSplatting = await loadGaussianSplatting(scene, "./assets/drone_cloud.sog", "droneSplat");

    // D. Gaussian Splatting — Vue Sol
    setProgress(80, "Chargement du nuage sol…");
    groundSplatting = await loadGaussianSplatting(scene, "./assets/ground_cloud.sog", "groundSplat");
    
    // ⚡ NOUVEAU : Application de l'optimisation progressive si le nuage est chargé
    if (groundSplatting) {
        groundSplatting.setEnabled(false); // Reste désactivé par défaut au démarrage (vue drone)

        // On attend une micro-seconde que le matériau soit bien instancié par Babylon
        setTimeout(() => {
            if (groundSplatting.material) {
                // On attache notre plugin de densité au matériau du splatting
                new SplatDensityPlugin(groundSplatting.material);
                // On force le shader à se recompiler avec notre code
                groundSplatting.material.markAsDirty(BABYLON.Material.TextureDirtyFlag);
                console.log("🚀 Optimisation de densité progressive activée sur le nuage Sol !");
            }
        }, 50);
    } // 🔍 FIX : Bloc if refermé correctement ici
    
    hideLoading();

    // ─────────────────────────────────────
    // MARQUEUR VISUEL DE DESTINATION
    // ─────────────────────────────────────
    function createWalkTarget(position) {
        if (walkTarget) walkTarget.dispose();
        walkTarget = BABYLON.MeshBuilder.CreateDisc("walkTarget", { radius: 0.3, tessellation: 24 }, scene);
        walkTarget.rotation.x = Math.PI / 2;
        walkTarget.position   = position.clone();
        walkTarget.position.y += 0.05;
        const mat = new BABYLON.StandardMaterial("walkMat", scene);
        mat.emissiveColor = new BABYLON.Color3(0.4, 0.7, 1);
        walkTarget.material = mat;
        setTimeout(() => { if (walkTarget) { walkTarget.dispose(); walkTarget = null; } }, 2000);
    }

    // ─────────────────────────────────────
    // ANIMATION CHEMIN
    // ─────────────────────────────────────
    function stopCurrentWalk() {
        if (currentWalkAnim) {
            currentWalkAnim.stop();
            currentWalkAnim = null;
        }
    }

    function animatePath(camera, pathPoints) {
        stopCurrentWalk();
        if (!pathPoints || pathPoints.length === 0) return;

        if (pathPoints.length === 1) {
            camera.position.x = pathPoints[0].x;
            camera.position.y = pathPoints[0].y + 0.8;
            camera.position.z = pathPoints[0].z;
            return;
        }

        let idx = 1;
        const EYE_HEIGHT = 0.8;
        const SPEED = 4;

        function step() {
            if (idx >= pathPoints.length) return;

            const from = camera.position.clone();
            const to   = new BABYLON.Vector3(
                pathPoints[idx].x,
                pathPoints[idx].y + EYE_HEIGHT,
                pathPoints[idx].z
            );

            const dist   = BABYLON.Vector3.Distance(from, to);
            const frames = Math.max(8, Math.round((dist / SPEED) * 60));

            const dx = to.x - from.x;
            const dz = to.z - from.z;
            if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
                camera.rotation.y = Math.atan2(dx, dz);
            }

            currentWalkAnim = BABYLON.Animation.CreateAndStartAnimation(
                "walk", camera, "position",
                60, frames,
                from, to,
                BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
                new BABYLON.CubicEase(),
                () => {
                    idx++;
                    step();
                }
            );
        }
        step();
    }

    // ─────────────────────────────────────
    // CLICK-TO-WALK (ANTI-CONFLIT CLIC/DRAG)
    // ─────────────────────────────────────
    let startX = 0;
    let startY = 0;

    scene.onPointerDown = function (evt) {
        if (currentMode !== "ground" || evt.button !== 0) return;
        startX = scene.pointerX;
        startY = scene.pointerY;
    };

    scene.onPointerUp = function (evt, pickResult) {
        if (currentMode !== "ground") return;
        if (evt.button !== 0) return; 
        if (!pickResult || !pickResult.hit || !pickResult.pickedPoint) return;
        if (!isNavMeshReady || !navigationPlugin) return;

        const diffX = scene.pointerX - startX;
        const diffY = scene.pointerY - startY;
        const dragDistance = Math.sqrt(diffX * diffX + diffY * diffY);

        if (dragDistance > 5) {
            return;
        }

        const camPos = groundCam.position;
        const target = pickResult.pickedPoint;
        const feetPos = new BABYLON.Vector3(camPos.x, camPos.y - 0.8, camPos.z);

        try {
            const closestStart = navigationPlugin.getClosestPoint(feetPos);
            const closestEnd   = navigationPlugin.getClosestPoint(target);

            const startDist = BABYLON.Vector3.Distance(feetPos, closestStart);
            const endDist   = BABYLON.Vector3.Distance(target, closestEnd);

            if (startDist > 2.0) {
                console.warn("Caméra hors du NavMesh ou non projetable au sol. Clic ignoré.");
                return; 
            }

            if (endDist > 2.0) {
                console.warn("Destination trop éloignée du NavMesh. Clic ignoré.");
                return;
            }

            const path = navigationPlugin.computePath(closestStart, closestEnd);

            if (path && path.length >= 1) {
                createWalkTarget(target);
                animatePath(groundCam, path);
            } else {
                console.warn("Aucun chemin trouvé vers ce point.");
            }
        } catch (e) {
            console.error("Erreur NavMesh computePath :", e);
        }
    };

    // ─────────────────────────────────────
    // SWITCH VUES
    // ─────────────────────────────────────
    const btnDrone  = document.getElementById("btn-drone");
    const btnGround = document.getElementById("btn-ground");

    function switchView(mode) {
        currentMode = mode;

        if (mode === "drone") {
            btnDrone.classList.add("active");
            btnGround.classList.remove("active");
            hint.textContent = "Vue Drone — Clic + glisser pour orbiter · Scroll pour zoomer";
            crosshair.style.display = "none";

            groundCam.detachControl();
            stopCurrentWalk();
            scene.activeCamera = droneCam;
            droneCam.attachControl(canvas, true);

            if (mainMesh)        mainMesh.setEnabled(true);
            if (droneSplatting)  droneSplatting.setEnabled(true);
            if (groundSplatting) groundSplatting.setEnabled(false);

        } else if (mode === "ground") {
            btnGround.classList.add("active");
            btnDrone.classList.remove("active");
            hint.textContent = "Vue Sol — Clic sur le sol pour avancer · Glisser pour regarder";
            crosshair.style.display = "block";

            droneCam.detachControl();
            scene.activeCamera = groundCam;
            groundCam.attachControl(canvas, true);

            // ⚡ Configuration dynamique des inputs au moment du switch sol
            if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
                groundCam.angularSensibility = 1000; 
                groundCam.fov = 1.1; // Remis à 1.1 pour un grand angle propre (1.8 déformait trop)
                
                if (groundCam.inputs.attached.mouse) {
                    groundCam.inputs.attached.mouse.touchEnabled = true;
                }
            } else {
                groundCam.angularSensibility = 3000; 
                groundCam.fov = 0.8; // Standard PC
            }

            if (isNavMeshReady && navigationPlugin) {
                try {
                    const sp = navigationPlugin.getClosestPoint(new BABYLON.Vector3(0, 2, 0));
                    groundCam.position = new BABYLON.Vector3(sp.x, sp.y + 0.8, sp.z);
                } catch(e) {
                    groundCam.position = new BABYLON.Vector3(0, 0.8, 0);
                }
            } else {
                groundCam.position = new BABYLON.Vector3(0, 0.8, 0);
            }

            if (mainMesh)        mainMesh.setEnabled(false);
            if (droneSplatting)  droneSplatting.setEnabled(false);
            if (groundSplatting) groundSplatting.setEnabled(true);
        }
    }

    btnDrone.addEventListener("click",  () => switchView("drone"));
    btnGround.addEventListener("click", () => switchView("ground"));

    // ─────────────────────────────────────
    // DEBUG NavMesh
    // ─────────────────────────────────────
    window._debugNavMesh = function() {
        if (!navigationPlugin || !isNavMeshReady) return console.warn("NavMesh non prêt");
        navigationPlugin.createDebugNavMesh(scene);
        console.log("NavMesh debug mesh ajouté à la scène");
    };

    return scene;
};

// ─────────────────────────────────────────
// 5. LANCEMENT
// ─────────────────────────────────────────
createScene().then((scene) => {
    engine.runRenderLoop(() => scene.render());
}).catch(e => {
    console.error("Erreur fatale createScene :", e);
    loadingText.innerText = "Erreur de chargement — voir la console";
});

window.addEventListener("resize", () => engine.resize());