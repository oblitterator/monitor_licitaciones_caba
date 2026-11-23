export default function Cargando() {
  return (
    <div className="main" aria-busy="true">
      <section className="box estado" style={{ gap: 14 }}>
        <span className="kicker">Cargando</span>
        <div className="skel" style={{ height: 14, width: "40%" }} />
        <div className="skel" style={{ height: 22, width: "90%" }} />
        <div className="skel" style={{ height: 14, width: "65%" }} />
        <div className="fila" style={{ gap: 12, flexWrap: "nowrap" }}>
          <div className="skel" style={{ height: 60, flex: 1 }} />
          <div className="skel" style={{ height: 60, flex: 1 }} />
          <div className="skel" style={{ height: 60, flex: 1 }} />
        </div>
        <p className="note m0" role="status">
          Buscando en el Boletín…
        </p>
      </section>
    </div>
  );
}
