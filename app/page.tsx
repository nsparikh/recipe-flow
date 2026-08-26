export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        gap: "0.5rem",
      }}
    >
      <h1 style={{ fontSize: "3rem", margin: 0 }}>Hello, world 👋</h1>
      <p style={{ color: "#666", margin: 0 }}>Recipe Flow is live on Vercel.</p>
    </main>
  );
}
