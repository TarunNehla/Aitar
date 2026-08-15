import { providerLabels, type SocialProvider } from "../../auth-client";
import { ProviderIcon } from "../ProviderIcon";
import { Spinner } from "../Spinner";

const providers: SocialProvider[] = ["google", "github"];

export function SocialSignInButtons({
  pending,
  disabled,
  onSelect,
}: {
  pending: SocialProvider | null;
  disabled: boolean;
  onSelect: (provider: SocialProvider) => void;
}) {
  return (
    <div className="provider-buttons">
      {providers.map((provider) => (
        <button
          className="ghost-button provider-button"
          key={provider}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(provider)}
        >
          <span className="provider-mark">
            {pending === provider ? <Spinner size={16} /> : <ProviderIcon provider={provider} size={16} />}
          </span>
          Continue with {providerLabels[provider]}
        </button>
      ))}
    </div>
  );
}
