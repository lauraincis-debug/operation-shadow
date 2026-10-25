import { useEffect, useState } from "react";

function performanceColor(value) {
  if (value === null || value === undefined) return "#8790b8";
  if (value >= 60) return "#00e676";
  if (value >= 48) return "#ffea00";
  return "#ff6b6b";
}

export default function LearningPerformanceBubble({
  metrics,
  learning,
  generation,
  onOpenHistory,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rate = metrics?.accuracyPct ?? null;
  const sample = metrics?.total || 0;
  const minSample = metrics?.minimumSample || 30;
  const color = performanceColor(rate);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);

  return (
    <>
      {isOpen && (
        <section
          className="fai-performance-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="fai-performance-title"
        >
          <div className="fai-performance-panel-head">
            <div>
              <div className="fai-performance-eyebrow">MESURE RÉELLE</div>
              <h2 id="fai-performance-title">Performance &amp; apprentissage</h2>
            </div>
            <button
              type="button"
              className="fai-performance-close"
              onClick={() => setIsOpen(false)}
              aria-label="Fermer le détail des performances"
            >
              ×
            </button>
          </div>

          <div className="fai-performance-status" style={{ borderColor: `${color}66` }}>
            <span className="fai-performance-status-dot" style={{ background: color }} />
            {rate === null
              ? `Performance non mesurée : ${sample}/${minSample} pronostics officiellement évalués.`
              : `Taux 1X2 prospectif mesuré sur ${sample} rencontres pré-match vérifiées.`}
          </div>

          <div className="fai-performance-grid">
            <div className="fai-performance-stat">
              <span>Taux de réussite 1X2</span>
              <strong style={{ color }}>{rate === null ? "—" : `${rate}%`}</strong>
            </div>
            <div className="fai-performance-stat">
              <span>Corrects / erreurs</span>
              <strong>{metrics?.correct || 0} / {metrics?.errors || 0}</strong>
            </div>
            <div className="fai-performance-stat">
              <span>Prévisions répétées exclues</span>
              <strong>{metrics?.duplicateForecastRowsExcluded || 0}</strong>
            </div>
            <div className="fai-performance-stat">
              <span>Marchés gagnants</span>
              <strong>
                {metrics?.marketAccuracyPct === null || metrics?.marketAccuracyPct === undefined
                  ? "—"
                  : `${metrics.marketAccuracyPct}%`}
              </strong>
            </div>
            <div className="fai-performance-stat">
              <span>Brier (si échantillon suffisant)</span>
              <strong>{metrics?.brierScore === null || metrics?.brierScore === undefined ? "—" : metrics.brierScore.toFixed(3)}</strong>
            </div>
          </div>

          <div className="fai-performance-divider" />
          <div className="fai-performance-learning-title">
            Apprentissage du modèle — Génération #{generation || 1}
          </div>
          <div className="fai-performance-learning-list">
            <div>
              <span>Résultats officiels intégrés</span>
              <strong>{learning?.officialResults || 0}</strong>
            </div>
            <div>
              <span>Scores saisis / ancien historique, non vérifiés</span>
              <strong>{learning?.unverifiedOrLegacyResults || 0}</strong>
            </div>
            <div>
              <span>Équipes avec résultats officiels</span>
              <strong>{learning?.teamsWithOfficialResults || 0}</strong>
            </div>
            <div>
              <span>Équipes avec résultats appris</span>
              <strong>{learning?.teamsWithAnyLearnedResult || 0}</strong>
            </div>
            {(learning?.excludedCalibrationRows || 0) > 0 && (
              <div>
                <span>Exemples de calibration exclus</span>
                <strong>{learning.excludedCalibrationRows}</strong>
              </div>
            )}
          </div>

          <p className="fai-performance-note">
            Seuls les pronostics enregistrés avant le coup d&apos;envoi et reliés ensuite à un score
            officiel entrent dans le taux. Les pronostics rétroactifs, manuels non vérifiés,
            historiques anciens et calibrations sont exclus. Un échantillon inférieur à {minSample}
            ne permet pas d&apos;afficher un pourcentage fiable; ce taux ne garantit aucun gain.
          </p>

          {onOpenHistory && (
            <button
              type="button"
              className="fai-performance-history-button"
              onClick={() => {
                setIsOpen(false);
                onOpenHistory();
              }}
            >
              Ouvrir l&apos;historique des pronostics
            </button>
          )}
        </section>
      )}

      <button
        type="button"
        className={`fai-performance-bubble ${isOpen ? "is-open" : ""}`}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={
          rate === null
            ? `Performance IA non mesurée, ${sample} sur ${minSample} pronostics évalués. Ouvrir les détails.`
            : `Performance IA ${rate} pour cent sur ${sample} pronostics évalués. Ouvrir les détails.`
        }
        style={{ "--performance-color": color }}
      >
        <span className="fai-performance-bubble-ring">
          <span>{rate === null ? "—" : `${rate}%`}</span>
        </span>
        <span className="fai-performance-bubble-copy">
          <strong>Performance IA</strong>
          <small>{rate === null ? `${sample}/${minSample} évalués` : `${sample} vérifiés`}</small>
        </span>
        <span className="fai-performance-bubble-chevron" aria-hidden="true">
          {isOpen ? "⌄" : "⌃"}
        </span>
      </button>
    </>
  );
}
