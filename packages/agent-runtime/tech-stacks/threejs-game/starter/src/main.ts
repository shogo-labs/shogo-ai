import * as THREE from 'three'
import * as CANNON from 'cannon-es'

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(0, 5, 10)
camera.lookAt(0, 0, 0)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
document.getElementById('app')!.appendChild(renderer.domElement)

const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
scene.add(ambientLight)
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
dirLight.position.set(10, 20, 10)
dirLight.castShadow = true
scene.add(dirLight)

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })

const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(50, 50),
  new THREE.MeshStandardMaterial({ color: 0x556b2f })
)
groundMesh.rotation.x = -Math.PI / 2
groundMesh.receiveShadow = true
scene.add(groundMesh)

const groundBody = new CANNON.Body({
  type: CANNON.Body.STATIC,
  shape: new CANNON.Plane(),
})
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
world.addBody(groundBody)

const boxMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xff6600 })
)
boxMesh.castShadow = true
scene.add(boxMesh)

const boxBody = new CANNON.Body({
  mass: 1,
  shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
  position: new CANNON.Vec3(0, 5, 0),
})
world.addBody(boxBody)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

const clock = new THREE.Clock()
const fixedTimeStep = 1 / 60
let accumulator = 0

function animate() {
  requestAnimationFrame(animate)
  const delta = clock.getDelta()
  accumulator += delta

  while (accumulator >= fixedTimeStep) {
    world.step(fixedTimeStep)
    accumulator -= fixedTimeStep
  }

  boxMesh.position.copy(boxBody.position as unknown as THREE.Vector3)
  boxMesh.quaternion.copy(boxBody.quaternion as unknown as THREE.Quaternion)

  renderer.render(scene, camera)
}
animate()
