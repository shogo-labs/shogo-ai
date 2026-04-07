# Tech Stack — Unity Game (Preview)

> This tech stack is a preview. Full Unity runtime support (with .NET SDK and Unity CLI) is coming in a future update. For now, use this stack to plan and write C# scripts that can be imported into a Unity project.

## Project Structure

```
Assets/
  Scripts/
    Player/
      PlayerController.cs    ← Player movement, input, animation
      PlayerHealth.cs         ← Health system, damage, death
    Enemies/
      EnemyAI.cs              ← Enemy behavior, pathfinding
      EnemySpawner.cs         ← Wave-based spawning
    Systems/
      GameManager.cs          ← Game state, score, level progression
      UIManager.cs            ← HUD, menus, pause screen
      AudioManager.cs         ← Sound effects, music
    Utilities/
      ObjectPool.cs           ← Object pooling for performance
      Singleton.cs            ← MonoBehaviour singleton pattern
  Prefabs/                    ← Reusable game object templates
  Materials/                  ← Shaders and materials
  Scenes/                     ← Unity scene files
ProjectSettings/
```

## C# Patterns for Unity

### MonoBehaviour lifecycle
```csharp
using UnityEngine;

public class PlayerController : MonoBehaviour
{
    [SerializeField] private float moveSpeed = 5f;
    [SerializeField] private float jumpForce = 10f;

    private Rigidbody2D rb;
    private bool isGrounded;

    void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
    }

    void Update()
    {
        float horizontal = Input.GetAxisRaw("Horizontal");
        rb.velocity = new Vector2(horizontal * moveSpeed, rb.velocity.y);

        if (Input.GetButtonDown("Jump") && isGrounded)
        {
            rb.velocity = new Vector2(rb.velocity.x, jumpForce);
        }
    }

    void OnCollisionEnter2D(Collision2D collision)
    {
        if (collision.gameObject.CompareTag("Ground"))
            isGrounded = true;
    }

    void OnCollisionExit2D(Collision2D collision)
    {
        if (collision.gameObject.CompareTag("Ground"))
            isGrounded = false;
    }
}
```

### Singleton pattern
```csharp
public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    public int Score { get; private set; }
    public bool IsGameOver { get; private set; }

    void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    public void AddScore(int points)
    {
        Score += points;
        OnScoreChanged?.Invoke(Score);
    }

    public event System.Action<int> OnScoreChanged;
}
```

### Object pooling
```csharp
public class ObjectPool : MonoBehaviour
{
    [SerializeField] private GameObject prefab;
    [SerializeField] private int initialSize = 10;

    private Queue<GameObject> pool = new Queue<GameObject>();

    void Start()
    {
        for (int i = 0; i < initialSize; i++)
        {
            var obj = Instantiate(prefab);
            obj.SetActive(false);
            pool.Enqueue(obj);
        }
    }

    public GameObject Get(Vector3 position, Quaternion rotation)
    {
        var obj = pool.Count > 0 ? pool.Dequeue() : Instantiate(prefab);
        obj.transform.SetPositionAndRotation(position, rotation);
        obj.SetActive(true);
        return obj;
    }

    public void Return(GameObject obj)
    {
        obj.SetActive(false);
        pool.Enqueue(obj);
    }
}
```

## Important Rules

- Use `[SerializeField]` for inspector-exposed fields, not `public`
- Prefer composition over inheritance — use separate components for separate concerns
- Cache component references in `Awake()`, not in `Update()`
- Use `CompareTag()` instead of `== "tag"` for performance
- Use object pooling for frequently spawned/destroyed objects (bullets, particles, enemies)
- Organize scripts by feature (Player/, Enemies/, Systems/) not by type
- Use events (`System.Action`, `UnityEvent`) for loose coupling between systems

## Current Limitations

This is a preview stack. The agent can write C# scripts, plan game architecture, and create project scaffolds, but cannot compile or run Unity projects in the current runtime. Export the scripts to a local Unity project for testing.
