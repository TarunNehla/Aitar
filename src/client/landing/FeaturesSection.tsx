import { Icon } from "../components/Icon";

export function FeaturesSection() {
  return (
    <section id="features" className="section-container">
      <div className="section-header">
        <span className="section-kicker">Core Superpowers</span>
        <h2 className="section-title">Built for real engineering workflows</h2>
        <p className="section-sub">
          Most coding agents are text wrappers that hallucinate commands. Aitar is a full cloud
          operating environment equipped with isolated Linux containers and autonomous web testing.
        </p>
      </div>

      <div className="features-bento">
        {/* Feature 1: Docker Sandboxes (Span 2) */}
        <div className="bento-card span-2">
          <div className="bento-icon-wrap teal">
            <Icon name="layers" size={20} />
          </div>
          <h3 className="bento-card-title">100% Isolated Docker Sandboxes</h3>
          <p className="bento-card-desc">
            Every session boots into a fresh <code>node:22-bookworm</code> container. With strict CPU,
            memory, and execution boundaries, the agent executes bash commands, installs packages, and runs
            tests without ever touching your local laptop or personal machine.
          </p>
          <div className="bento-snippet">
            <div className="bento-code-block">
              docker run --user 1000:1000 --cpus 1 --memory 2048m \{"\n"}
              {"  "}--mount type=bind,src=/workspace,dst=/workspace \{"\n"}
              {"  "}node:22-bookworm bash -c "pnpm install &amp;&amp; pnpm test"
            </div>
          </div>
        </div>

        {/* Feature 2: Browser Sidecar */}
        <div className="bento-card">
          <div className="bento-icon-wrap blue">
            <Icon name="globe" size={20} />
          </div>
          <h3 className="bento-card-title">Chromium Browser Sidecar</h3>
          <p className="bento-card-desc">
            Aitar launches a dedicated browser container attached to the chat network. The agent opens dev
            servers, clicks elements, enters form data, captures screenshots, and checks console logs for runtime errors.
          </p>
          <div className="bento-snippet">
            <div className="bento-code-block">
              browser_navigate("http://localhost:5173"){"\n"}
              browser_click("button#checkout"){"\n"}
              browser_screenshot() // validated!
            </div>
          </div>
        </div>

        {/* Feature 3: Multi-Model Reasoning */}
        <div className="bento-card">
          <div className="bento-icon-wrap violet">
            <Icon name="sparkles" size={20} />
          </div>
          <h3 className="bento-card-title">Hybrid Reasoning Models</h3>
          <p className="bento-card-desc">
            Harness Claude 3.7 Sonnet with extended thinking, DeepSeek V3/V4 for hyper-fast execution,
            and Gemini 3.7 Flash for multimodal vision. Adjust reasoning depth per task.
          </p>
          <div className="bento-snippet">
            <div className="bento-code-block">
              Thinking Level: [ Off | Low | Med | High ]{"\n"}
              Vision Routing: Auto (Gemini 3.7 Flash)
            </div>
          </div>
        </div>

        {/* Feature 4: Git-Native Checkpoints */}
        <div className="bento-card">
          <div className="bento-icon-wrap teal">
            <Icon name="folder-git-2" size={20} />
          </div>
          <h3 className="bento-card-title">Safe Git Checkpointing</h3>
          <p className="bento-card-desc">
            Every assistant run creates a detached HEAD commit. View unified diffs, download raw <code>.patch</code>{" "}
            files, or roll back turns without polluting your main branch.
          </p>
          <div className="bento-snippet">
            <div className="bento-code-block">
              refs/cloud-agents/chats/e8f9a2{"\n"}
              checkpoint: 7b1d24e (+42, -6)
            </div>
          </div>
        </div>

        {/* Feature 5: Direct GitHub PRs */}
        <div className="bento-card">
          <div className="bento-icon-wrap blue">
            <Icon name="git-pull-request" size={20} />
          </div>
          <h3 className="bento-card-title">1-Click GitHub Pull Requests</h3>
          <p className="bento-card-desc">
            Once code changes pass browser tests and lint checks, Aitar writes a markdown PR summary, pushes
            to your repository via the GitHub App, and generates the Pull Request.
          </p>
          <div className="bento-snippet">
            <div className="bento-code-block">
              create_pull_request({"{"}{"\n"}
              {"  "}title: "feat: dark mode toggle",{"\n"}
              {"  "}base: "main"{"\n"}
              {"}"}) // drafted on GitHub!
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
