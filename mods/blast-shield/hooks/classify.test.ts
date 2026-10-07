import { test, expect } from 'claude-code/testing'
// @ts-ignore untyped .mjs
import { classify } from './blast-shield.mjs'

const kind = (c: string) => classify(c)?.kind ?? null

test('still catches the original set', async () => {
  expect(kind('rm -rf build')).toBe('rm')
  expect(kind('git reset --hard')).toBe('git-reset')
  expect(kind('git clean -fd')).toBe('git-clean')
  expect(kind('git push --force origin main')).toBe('git-push-force')
  expect(kind('ls -la')).toBe(null)
})

test('closes the coverage gaps', async () => {
  expect(kind('git push -uf origin main')).toBe('git-push-force')
  expect(kind('git checkout -- src/a.js')).toBe('git-checkout')
  expect(kind('git restore src/a.js')).toBe('git-checkout')
  expect(kind('git branch -D feature')).toBe('git-branch-delete')
  expect(kind('git stash drop')).toBe('git-stash')
  expect(kind('git stash clear')).toBe('git-stash')
  expect(kind('timeout 5 rm -rf build')).toBe('rm')
  expect(kind('doas rm -rf build')).toBe('rm')
  expect(kind('env -i rm -rf build')).toBe('rm')
  expect(kind('time -p rm -rf build')).toBe('rm')
  expect(kind('ls | xargs rm')).toBe('opaque')
  expect(kind('find . -name "*.o" -' + 'delete')).toBe('find-delete')
})

test('does not hold harmless look-alikes', async () => {
  expect(kind('git checkout main')).toBe(null)
  expect(kind('git restore --staged src/a.js')).toBe(null)
  expect(kind('git branch -d merged')).toBe(null)
  expect(kind('git stash list')).toBe(null)
  expect(kind('git push origin main')).toBe(null)
  expect(kind('find . -name x')).toBe(null)
})

test('holds docker, kubectl, terraform, destructive SQL and recursive chmod', async () => {
  expect(kind('docker system prune -af')).toBe('opaque')
  expect(kind('docker volume rm data')).toBe('opaque')
  expect(kind('docker compose down -v')).toBe('opaque')
  expect(kind('docker-compose down --volumes')).toBe('opaque')
  expect(kind('kubectl delete pod web-1')).toBe('kubectl-delete')
  expect(kind('kubectl -n prod delete deploy api')).toBe('kubectl-delete')
  expect(kind('terraform destroy -auto-approve')).toBe('terraform-destroy')
  expect(kind('tofu apply -destroy')).toBe('terraform-destroy')
  expect(kind('psql -c "DROP TABLE users"')).toBe('opaque')
  expect(kind('psql -c "truncate table users"')).toBe('opaque')
  expect(kind('mysql -e "DELETE FROM orders"')).toBe('opaque')
  expect(kind('chmod -R 777 .')).toBe('rm')
  expect(kind('chown -R me:me /srv/app')).toBe('rm')
})

test('leaves the safe forms of those commands alone', async () => {
  expect(kind('docker ps')).toBe(null)
  expect(kind('docker compose down')).toBe(null)
  expect(kind('docker image prune')).toBe(null)
  expect(kind('kubectl get pods')).toBe(null)
  expect(kind('kubectl -n delete get pods')).toBe(null)
  expect(kind('terraform plan')).toBe(null)
  expect(kind('terraform apply')).toBe(null)
  expect(kind('psql -c "SELECT 1"')).toBe(null)
  expect(kind('mysql -e "DELETE FROM orders WHERE id = 1"')).toBe(null)
  expect(kind('chmod +x run.sh')).toBe(null)
  expect(kind('chmod 644 a.txt')).toBe(null)
})

test('chmod -R targets skip the mode word', async () => {
  expect(classify('chmod -R 755 build dist')?.targets).toEqual(['build', 'dist'])
})
