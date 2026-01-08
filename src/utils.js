export const cached = (fn) => {
	let cache = null
	return () => (cache ?? (cache = fn()))
}

export const cachedStr = (fn) => {
	const cache = Object.create(null)
	return (key) => (cache[key] ?? (cache[key] = fn(key)))
}
